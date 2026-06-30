import dataclasses
import datetime
import shutil
import socket
import subprocess
import threading
import time
import uuid
from collections import deque
from scapy.all import (
    AsyncSniffer, Ether, Dot1Q, IP, UDP, TCP, ICMP, Raw,
    get_if_list, get_if_hwaddr,
)

# ─── Multi-stream TX state ────────────────────────────────────────────────────

_AUTO_STOP_SECS = 900  # 15 minutes per stream


@dataclasses.dataclass
class StreamState:
    stream_id:  str
    cfg:        dict
    rate:       float
    iface:      str
    stop_event: threading.Event
    thread:     threading.Thread
    timer:      threading.Timer | None
    sent:       int  # written only by owning thread; GIL-safe int read from any thread


_streams: dict[str, StreamState] = {}
_streams_lock = threading.Lock()

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


_ETH_P_ALL = 0x0003


def _open_raw_socket(iface: str) -> socket.socket:
    """Raw L2 socket bound to iface; bypasses Scapy's per-packet send overhead."""
    sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(_ETH_P_ALL))
    sock.bind((iface, 0))
    return sock


def send_fixed(cfg: dict, count: int, iface: str) -> int:
    raw = bytes(_build_packet(cfg))
    sock = _open_raw_socket(iface)
    try:
        send = sock.send
        for _ in range(count):
            send(raw)
    finally:
        sock.close()
    return count


def _stream_worker(state: StreamState) -> None:
    raw  = bytes(_build_packet(state.cfg))
    sock = _open_raw_socket(state.iface)
    send = sock.send
    rate = state.rate
    stop = state.stop_event

    try:
        if rate <= 0:
            while not stop.is_set():
                for _ in range(2000):
                    send(raw)
                state.sent += 2000
            return

        window = max(0.01, 1.0 / rate)
        batch  = max(1, int(rate * window))

        while not stop.is_set():
            t0 = time.monotonic()
            for _ in range(batch):
                send(raw)
            state.sent += batch
            elapsed   = time.monotonic() - t0
            remainder = window - elapsed
            if remainder > 0.0001:
                stop.wait(remainder)
    finally:
        sock.close()


def _auto_stop_stream(stream_id: str) -> None:
    stop_stream(stream_id)


def start_stream(cfg: dict, rate: float, iface: str) -> tuple[str, str]:
    stream_id  = uuid.uuid4().hex[:8]
    stop_event = threading.Event()
    state = StreamState(
        stream_id=stream_id, cfg=cfg, rate=rate, iface=iface,
        stop_event=stop_event, thread=None, timer=None, sent=0,  # type: ignore[arg-type]
    )
    thread = threading.Thread(
        target=_stream_worker, args=(state,), daemon=True, name=f"tx-{stream_id}"
    )
    state.thread = thread
    timer = threading.Timer(_AUTO_STOP_SECS, _auto_stop_stream, args=(stream_id,))
    timer.daemon = True
    state.timer = timer

    with _streams_lock:
        _streams[stream_id] = state

    thread.start()
    timer.start()
    return stream_id, "Stream started"


def stop_stream(stream_id: str) -> tuple[bool, int]:
    with _streams_lock:
        state = _streams.pop(stream_id, None)
    if state is None:
        return False, 0
    if state.timer:
        state.timer.cancel()
    state.stop_event.set()
    state.thread.join(timeout=3.0)
    return True, state.sent


def stop_all_streams() -> dict[str, int]:
    with _streams_lock:
        ids = list(_streams.keys())
    results = {}
    for sid in ids:
        found, sent = stop_stream(sid)
        if found:
            results[sid] = sent
    return results


def get_stream_status(stream_id: str) -> dict | None:
    with _streams_lock:
        state = _streams.get(stream_id)
    if state is None:
        return None
    return {
        "stream_id": state.stream_id,
        "running":   state.thread.is_alive(),
        "sent":      state.sent,
        "rate":      state.rate,
        "iface":     state.iface,
        "protocol":  state.cfg.get("protocol", "udp"),
        "src_port":  state.cfg.get("src_port"),
        "dst_port":  state.cfg.get("dst_port"),
        "dscp":      state.cfg.get("dscp", 0),
        "pkt_size":  state.cfg.get("pkt_size"),
    }


def list_streams() -> list[dict]:
    with _streams_lock:
        ids = list(_streams.keys())
    return [s for sid in ids if (s := get_stream_status(sid)) is not None]


def any_sending() -> bool:
    with _streams_lock:
        return bool(_streams)


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
