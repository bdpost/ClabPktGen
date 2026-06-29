import datetime
import shutil
import socket
import subprocess
import threading
import time
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

# ─── iperf3 state ─────────────────────────────────────────────────────────────

_iperf3_proc: subprocess.Popen | None = None
_iperf3_output: list[str] = []   # bounded at 500 lines, index-addressable
_iperf3_lock = threading.Lock()
_iperf3_running = False
_iperf3_reader: threading.Thread | None = None


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

    if rate <= 0:
        # Unlimited — blast in large batches to avoid per-call Python overhead
        batch = 512
        while not _stop_event.is_set():
            sendp(pkt, iface=iface, count=batch, inter=0, verbose=False)
            _sent_count += batch
        return

    # Rate-controlled: compute batch size for a 10 ms window (or longer for very
    # low rates so we always send at least 1 packet per window).
    window = max(0.01, 1.0 / rate)
    batch = max(1, int(rate * window))

    while not _stop_event.is_set():
        t0 = time.monotonic()
        sendp(pkt, iface=iface, count=batch, inter=0, verbose=False)
        _sent_count += batch
        elapsed = time.monotonic() - t0
        remainder = window - elapsed
        if remainder > 0.0001:
            _stop_event.wait(remainder)


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


# ─── iperf3 ───────────────────────────────────────────────────────────────────

def _iperf3_reader_worker(proc: subprocess.Popen):
    global _iperf3_running
    try:
        for line in proc.stdout:
            stripped = line.rstrip('\n')
            with _iperf3_lock:
                _iperf3_output.append(stripped)
                if len(_iperf3_output) > 500:
                    _iperf3_output.pop(0)
    finally:
        proc.wait()
        with _iperf3_lock:
            _iperf3_running = False


def start_iperf3(mode: str, **kwargs) -> tuple[bool, str]:
    global _iperf3_proc, _iperf3_output, _iperf3_running, _iperf3_reader

    with _iperf3_lock:
        if _iperf3_running:
            return False, "iperf3 already running"

    if not shutil.which('iperf3'):
        return False, "iperf3 not found in PATH"

    cmd = ['iperf3']
    if mode == 'server':
        cmd += ['-s', '-p', str(kwargs.get('port', 5201))]
        if kwargs.get('one_off'):
            cmd.append('--one-off')
    else:
        host = str(kwargs.get('host', '')).strip()
        if not host:
            return False, "Target host is required for client mode"
        cmd += ['-c', host, '-p', str(kwargs.get('port', 5201))]
        bind_ip = str(kwargs.get('bind_ip', '')).strip()
        if bind_ip:
            cmd += ['-B', bind_ip]
        if str(kwargs.get('protocol', 'tcp')).lower() == 'udp':
            cmd.append('-u')
        cmd += ['-t', str(int(kwargs.get('duration', 10)))]
        bandwidth = str(kwargs.get('bandwidth', '')).strip()
        if bandwidth:
            cmd += ['-b', bandwidth]
        parallel = int(kwargs.get('parallel', 1))
        if parallel > 1:
            cmd += ['-P', str(parallel)]
        if kwargs.get('reverse'):
            cmd.append('-R')

    with _iperf3_lock:
        _iperf3_output.clear()
        _iperf3_running = True

    try:
        _iperf3_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        with _iperf3_lock:
            _iperf3_running = False
        return False, "iperf3 binary not found"

    _iperf3_reader = threading.Thread(
        target=_iperf3_reader_worker, args=(_iperf3_proc,), daemon=True
    )
    _iperf3_reader.start()

    mode_label = "server" if mode == "server" else f"client → {kwargs.get('host')}"
    return True, f"iperf3 started ({mode_label})"


def stop_iperf3() -> int:
    global _iperf3_proc, _iperf3_running
    with _iperf3_lock:
        _iperf3_running = False
    if _iperf3_proc is not None:
        try:
            _iperf3_proc.terminate()
            _iperf3_proc.wait(timeout=3.0)
        except Exception:
            try:
                _iperf3_proc.kill()
            except Exception:
                pass
        _iperf3_proc = None
    with _iperf3_lock:
        return len(_iperf3_output)


def get_iperf3_output(since: int = 0) -> list[str]:
    with _iperf3_lock:
        return _iperf3_output[since:]


def is_iperf3_running() -> bool:
    with _iperf3_lock:
        return _iperf3_running


def iperf3_line_count() -> int:
    with _iperf3_lock:
        return len(_iperf3_output)
