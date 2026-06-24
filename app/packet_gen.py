import datetime
import socket
import subprocess
import threading
from collections import deque
from scapy.all import (
    AsyncSniffer, Ether, Dot1Q, IP, UDP, TCP, ICMP, Raw,
    sendp, get_if_list, get_if_hwaddr,
)

# ─── TX state ─────────────────────────────────────────────────────────────────

_send_thread: threading.Thread | None = None
_stop_event = threading.Event()
_sent_count = 0
_tx_timer: threading.Timer | None = None

_AUTO_STOP_SECS = 300  # 5 minutes

# ─── Passive capture state ────────────────────────────────────────────────────

_rx_sniffer: AsyncSniffer | None = None
_rx_packets: deque = deque(maxlen=500)
_rx_raw_packets: deque = deque(maxlen=500)  # raw Scapy packets for pcap export
_rx_lock = threading.Lock()
_rx_total = 0   # monotonic; used as "since" baseline for incremental polling
_rx_timer: threading.Timer | None = None

# ─── Socket listener state ────────────────────────────────────────────────────

_listener_thread: threading.Thread | None = None
_listener_stop = threading.Event()
_listener_count = 0   # TCP: connections accepted  |  UDP: datagrams received
_listener_lock = threading.Lock()


_VIRT_PREFIXES = ("lo", "docker", "veth", "br-", "virbr", "dummy", "bond", "tun", "tap")

def get_interfaces() -> list[str]:
    return [
        i for i in get_if_list()
        if not any(i == p or i.startswith(p) for p in _VIRT_PREFIXES)
    ]


def get_hwaddr(iface: str) -> str:
    try:
        return get_if_hwaddr(iface)
    except Exception:
        return ""


def get_iface_addr(iface: str) -> str:
    """Return the first IPv4 address (CIDR) on iface, or '' if none assigned."""
    try:
        out = subprocess.check_output(
            ["ip", "-4", "addr", "show", iface], text=True
        )
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("inet "):
                return line.split()[1]  # e.g. "10.192.160.101/24"
    except Exception:
        pass
    return ""


# ─── TX ───────────────────────────────────────────────────────────────────────

def _build_packet(cfg: dict):
    eth = Ether(src=cfg["src_mac"], dst=cfg["dst_mac"])
    if cfg.get("vlan_id") is not None:
        eth = eth / Dot1Q(vlan=cfg["vlan_id"], prio=cfg.get("vlan_pcp", 0))
    # DSCP occupies the high 6 bits of the ToS byte
    ip = IP(src=cfg["src_ip"], dst=cfg["dst_ip"], tos=cfg.get("dscp", 0) << 2)
    proto = cfg.get("protocol", "udp").lower()
    if proto == "tcp":
        transport = TCP(sport=cfg.get("src_port", 12345), dport=cfg.get("dst_port", 80), flags="S")
    elif proto == "icmp":
        transport = ICMP()
    else:
        transport = UDP(sport=cfg.get("src_port", 12345), dport=cfg.get("dst_port", 80))

    payload_bytes = (cfg.get("payload", "PktGen") or "PktGen").encode()
    pkt_size = cfg.get("pkt_size")
    if pkt_size and pkt_size > 0:
        header_len = len(eth / ip / transport)
        fill_len = max(0, pkt_size - header_len)
        if fill_len > 0 and payload_bytes:
            payload_bytes = (payload_bytes * ((fill_len // len(payload_bytes)) + 1))[:fill_len]
        else:
            payload_bytes = b'\x00' * fill_len

    return eth / ip / transport / Raw(load=payload_bytes)


def send_fixed(cfg: dict, count: int, iface: str) -> int:
    pkt = _build_packet(cfg)
    sendp(pkt, iface=iface, count=count, inter=0, verbose=False)
    return count


def _continuous_worker(cfg: dict, rate: float, iface: str):
    global _sent_count
    _sent_count = 0
    pkt = _build_packet(cfg)
    interval = 1.0 / rate if rate > 0 else 0
    while not _stop_event.is_set():
        sendp(pkt, iface=iface, count=1, verbose=False)
        _sent_count += 1
        if interval > 0:
            _stop_event.wait(interval)


def start_continuous(cfg: dict, rate: float, iface: str) -> tuple[bool, str]:
    global _send_thread, _tx_timer
    if _send_thread and _send_thread.is_alive():
        return False, "Already sending"
    _stop_event.clear()
    _send_thread = threading.Thread(
        target=_continuous_worker, args=(cfg, rate, iface), daemon=True
    )
    _send_thread.start()
    _tx_timer = threading.Timer(_AUTO_STOP_SECS, stop_continuous)
    _tx_timer.daemon = True
    _tx_timer.start()
    return True, "Stream started"


def stop_continuous() -> int:
    global _sent_count, _tx_timer
    if _tx_timer:
        _tx_timer.cancel()
        _tx_timer = None
    _stop_event.set()
    if _send_thread:
        _send_thread.join(timeout=3.0)
    return _sent_count


def is_sending() -> bool:
    return _send_thread is not None and _send_thread.is_alive()


def sent_count() -> int:
    return _sent_count


# ─── Passive Capture ──────────────────────────────────────────────────────────

def _process_packet(pkt):
    global _rx_total
    if not pkt.haslayer(IP):
        return

    _rx_total += 1
    now = datetime.datetime.now()

    record: dict = {
        "id":       _rx_total,
        "time":     f"{now.strftime('%H:%M:%S')}.{now.microsecond // 1000:03d}",
        "protocol": "IP",
        "src_ip":   pkt[IP].src,
        "dst_ip":   pkt[IP].dst,
        "src_port": None,
        "dst_port": None,
        "dscp":     pkt[IP].tos >> 2,
        "vlan":     pkt[Dot1Q].vlan if pkt.haslayer(Dot1Q) else None,
        "length":   len(pkt),
    }

    if pkt.haslayer(TCP):
        record["protocol"] = "TCP"
        record["src_port"] = pkt[TCP].sport
        record["dst_port"] = pkt[TCP].dport
    elif pkt.haslayer(UDP):
        record["protocol"] = "UDP"
        record["src_port"] = pkt[UDP].sport
        record["dst_port"] = pkt[UDP].dport
    elif pkt.haslayer(ICMP):
        record["protocol"] = "ICMP"

    with _rx_lock:
        _rx_packets.append(record)
        _rx_raw_packets.append(pkt)


def start_rx(iface: str, protocol: str = "all", port: int | None = None) -> tuple[bool, str]:
    global _rx_sniffer, _rx_total, _rx_timer
    if _rx_sniffer is not None and _rx_sniffer.running:
        return False, "Already capturing"

    with _rx_lock:
        _rx_packets.clear()
        _rx_raw_packets.clear()
    _rx_total = 0

    parts: list[str] = []
    if protocol.lower() in ("udp", "tcp", "icmp"):
        parts.append(protocol.lower())
    if port is not None:
        parts.append(f"port {port}")
    bpf = " and ".join(parts) or None

    _rx_sniffer = AsyncSniffer(iface=iface, filter=bpf, prn=_process_packet, store=False)
    _rx_sniffer.start()
    _rx_timer = threading.Timer(_AUTO_STOP_SECS, stop_rx)
    _rx_timer.daemon = True
    _rx_timer.start()
    return True, "Capture started"


def stop_rx() -> int:
    global _rx_sniffer, _rx_timer
    if _rx_timer:
        _rx_timer.cancel()
        _rx_timer = None
    if _rx_sniffer is not None and _rx_sniffer.running:
        _rx_sniffer.stop()
    _rx_sniffer = None
    return _rx_total


def get_rx_packets(since: int = 0) -> list[dict]:
    with _rx_lock:
        return [p for p in _rx_packets if p["id"] > since]


def get_rx_raw_packets() -> list:
    with _rx_lock:
        return list(_rx_raw_packets)


def clear_rx_packets() -> int:
    """Clear buffer; return current total so caller can update its since-baseline."""
    with _rx_lock:
        _rx_packets.clear()
        _rx_raw_packets.clear()
    return _rx_total


def is_receiving() -> bool:
    return _rx_sniffer is not None and _rx_sniffer.running


def rx_count() -> int:
    return _rx_total


# ─── Socket Listener ──────────────────────────────────────────────────────────

def _handle_tcp_conn(conn: socket.socket):
    try:
        conn.settimeout(30.0)
        while True:
            data = conn.recv(4096)
            if not data:
                break
            conn.sendall(b"PktGen ACK: " + data)
    except Exception:
        pass
    finally:
        conn.close()


def _listener_tcp_worker(bind_ip: str, port: int):
    global _listener_count
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(1.0)
    try:
        sock.bind((bind_ip, port))
        sock.listen(32)
        while not _listener_stop.is_set():
            try:
                conn, _addr = sock.accept()
            except socket.timeout:
                continue
            with _listener_lock:
                _listener_count += 1
            threading.Thread(target=_handle_tcp_conn, args=(conn,), daemon=True).start()
    finally:
        sock.close()


def _listener_udp_worker(bind_ip: str, port: int):
    global _listener_count
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(1.0)
    try:
        sock.bind((bind_ip, port))
        while not _listener_stop.is_set():
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                continue
            with _listener_lock:
                _listener_count += 1
            try:
                sock.sendto(b"PktGen ACK: " + data, addr)
            except Exception:
                pass
    finally:
        sock.close()


def start_listener(protocol: str, port: int, bind_ip: str = "0.0.0.0") -> tuple[bool, str]:
    global _listener_thread, _listener_count
    if _listener_thread is not None and _listener_thread.is_alive():
        return False, "Listener already running"
    _listener_stop.clear()
    with _listener_lock:
        _listener_count = 0
    worker = _listener_tcp_worker if protocol.lower() == "tcp" else _listener_udp_worker
    _listener_thread = threading.Thread(target=worker, args=(bind_ip, port), daemon=True)
    _listener_thread.start()
    return True, f"Listening on {bind_ip}:{port}/{protocol.upper()}"


def stop_listener() -> int:
    global _listener_thread
    _listener_stop.set()
    if _listener_thread is not None:
        _listener_thread.join(timeout=3.0)
    _listener_thread = None
    return _listener_count


def is_listening() -> bool:
    return _listener_thread is not None and _listener_thread.is_alive()


def listener_count() -> int:
    with _listener_lock:
        return _listener_count
