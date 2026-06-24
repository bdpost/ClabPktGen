import os
import subprocess
from typing import Optional

from io import BytesIO

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from scapy.all import PcapWriter
from pydantic import BaseModel, Field

import packet_gen


def _mgmt_iface() -> str:
    """Return the interface that holds the default route (management plane)."""
    try:
        out = subprocess.check_output(
            ["ip", "route", "show", "default"], text=True
        )
        for token in out.split():
            if token == "dev":
                return out.split()[out.split().index("dev") + 1]
    except Exception:
        pass
    return "eth0"


def _default_iface() -> str:
    """Return eth1 if present; otherwise the first non-mgmt physical interface."""
    ifaces = packet_gen.get_interfaces()
    if "eth1" in ifaces:
        return "eth1"
    mgmt = _mgmt_iface()
    for iface in ifaces:
        if iface != mgmt:
            return iface
    return ifaces[0] if ifaces else "eth1"

app = FastAPI(title="PktGen")

_static = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=_static), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(_static, "index.html"))


# ─── Packet models ────────────────────────────────────────────────────────────

class PacketConfig(BaseModel):
    src_mac: str = "de:ad:be:ef:00:01"
    dst_mac: str = "ff:ff:ff:ff:ff:ff"
    src_ip: str = "192.168.1.100"
    dst_ip: str = "192.168.1.1"
    vlan_id: Optional[int] = None
    vlan_pcp: int = 0
    dscp: int = 0
    protocol: str = "tcp"
    src_port: int = 12345
    dst_port: int = 80
    payload: str = "PktGen"
    pkt_size: Optional[int] = None


class SendRequest(PacketConfig):
    count: int = 1
    interface: str = Field(default_factory=_default_iface)


class StreamRequest(PacketConfig):
    rate: float = 2.0
    interface: str = Field(default_factory=_default_iface)


def _cfg(req: PacketConfig) -> dict:
    return req.model_dump()


# ─── Interface models ─────────────────────────────────────────────────────────

class InterfaceUp(BaseModel):
    interface: str = Field(default_factory=_default_iface)
    ip: str  # e.g. "10.1.1.2/24"


class InterfaceDown(BaseModel):
    interface: str = Field(default_factory=_default_iface)


# ─── Route models ─────────────────────────────────────────────────────────────

class RouteEntry(BaseModel):
    prefix: str        # e.g. "10.0.0.0/8"
    nexthop: str       # e.g. "10.1.1.1"
    interface: str = Field(default_factory=_default_iface)


class RouteFlush(BaseModel):
    interface: str = Field(default_factory=_default_iface)


class ArpResolveRequest(BaseModel):
    ip: str
    interface: str = Field(default_factory=_default_iface)


# ─── RX models ────────────────────────────────────────────────────────────────

class RxStartRequest(BaseModel):
    interface: str = Field(default_factory=_default_iface)
    protocol: str = "all"   # "all" | "udp" | "tcp" | "icmp"
    port: Optional[int] = None


class ListenerStartRequest(BaseModel):
    protocol: str = "tcp"   # "tcp" | "udp"
    port: int = 8888
    bind_ip: str = "0.0.0.0"


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _ipcmd(*args: str) -> None:
    result = subprocess.run(["ip"] + list(args), capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())


# ─── TX endpoints ─────────────────────────────────────────────────────────────

@app.post("/api/send")
async def send(req: SendRequest):
    cfg = _cfg(req)
    iface = cfg.pop("interface")
    count = cfg.pop("count")
    try:
        sent = packet_gen.send_fixed(cfg, count, iface)
        return {"status": "ok", "sent": sent, "interface": iface}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/start")
async def start(req: StreamRequest):
    cfg = _cfg(req)
    iface = cfg.pop("interface")
    rate = cfg.pop("rate")
    try:
        ok, msg = packet_gen.start_continuous(cfg, rate, iface)
        if not ok:
            raise HTTPException(status_code=409, detail=msg)
        return {"status": "ok", "message": msg, "interface": iface, "rate": rate}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/stop")
async def stop():
    sent = packet_gen.stop_continuous()
    return {"status": "ok", "sent": sent}


@app.get("/api/status")
async def status():
    return {
        "sending": packet_gen.is_sending(),
        "sent": packet_gen.sent_count(),
    }


@app.get("/api/interfaces")
async def interfaces():
    ifaces = packet_gen.get_interfaces()
    return {
        "interfaces": ifaces,
        "hwaddrs": {iface: packet_gen.get_hwaddr(iface) for iface in ifaces},
        "addrs":   {iface: packet_gen.get_iface_addr(iface) for iface in ifaces},
        "mgmt": _mgmt_iface(),
    }


# ─── Interface endpoints ──────────────────────────────────────────────────────

@app.post("/api/interface/up")
async def interface_up(req: InterfaceUp):
    try:
        # Flush existing addresses first so re-configuring is always idempotent
        subprocess.run(["ip", "addr", "flush", "dev", req.interface], capture_output=True)
        _ipcmd("addr", "add", req.ip, "dev", req.interface)
        _ipcmd("link", "set", req.interface, "up")
        return {"status": "ok", "interface": req.interface, "ip": req.ip}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/interface/down")
async def interface_down(req: InterfaceDown):
    errors = []
    for args in [
        ("route", "flush", "dev", req.interface),
        ("addr", "flush", "dev", req.interface),
    ]:
        result = subprocess.run(["ip"] + list(args), capture_output=True, text=True)
        if result.returncode != 0:
            errors.append(result.stderr.strip())
    if errors:
        raise HTTPException(status_code=500, detail="; ".join(errors))
    return {"status": "ok", "interface": req.interface}


# ─── Route endpoints ──────────────────────────────────────────────────────────

@app.post("/api/routes/add")
async def route_add(req: RouteEntry):
    try:
        _ipcmd("route", "add", req.prefix, "via", req.nexthop, "dev", req.interface)
        return {"status": "ok", "prefix": req.prefix, "nexthop": req.nexthop, "interface": req.interface}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/routes/del")
async def route_del(req: RouteEntry):
    try:
        _ipcmd("route", "del", req.prefix, "via", req.nexthop, "dev", req.interface)
        return {"status": "ok"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/routes/flush")
async def route_flush(req: RouteFlush):
    try:
        _ipcmd("route", "flush", "dev", req.interface)
        return {"status": "ok", "interface": req.interface}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── ARP endpoints ────────────────────────────────────────────────────────────

@app.post("/api/arp/resolve")
async def arp_resolve(req: ArpResolveRequest):
    """Ping the target to populate the ARP table, then return its MAC."""
    subprocess.run(
        ["ping", "-c", "1", "-W", "2", "-I", req.interface, req.ip],
        capture_output=True,
    )
    result = subprocess.run(
        ["ip", "neigh", "show", req.ip, "dev", req.interface],
        capture_output=True, text=True,
    )
    mac = None
    for line in result.stdout.splitlines():
        parts = line.split()
        if "lladdr" in parts:
            mac = parts[parts.index("lladdr") + 1]
            break
    if not mac:
        raise HTTPException(
            status_code=404,
            detail=f"No ARP entry for {req.ip} on {req.interface} — configure the interface IP first",
        )
    return {"ip": req.ip, "interface": req.interface, "mac": mac}


# ─── RX endpoints ─────────────────────────────────────────────────────────────

@app.post("/api/rx/start")
async def rx_start(req: RxStartRequest):
    ok, msg = packet_gen.start_rx(req.interface, req.protocol, req.port)
    if not ok:
        raise HTTPException(status_code=409, detail=msg)
    return {"status": "ok", "message": msg, "interface": req.interface}


@app.post("/api/rx/stop")
async def rx_stop():
    count = packet_gen.stop_rx()
    return {"status": "ok", "count": count}


@app.get("/api/rx/packets")
async def rx_packets(since: int = 0):
    return {
        "packets":   packet_gen.get_rx_packets(since),
        "receiving": packet_gen.is_receiving(),
        "count":     packet_gen.rx_count(),
    }


@app.delete("/api/rx/packets")
async def rx_clear():
    baseline = packet_gen.clear_rx_packets()
    return {"status": "ok", "baseline": baseline}


@app.get("/api/rx/pcap")
async def rx_pcap():
    pkts = packet_gen.get_rx_raw_packets()
    if not pkts:
        raise HTTPException(status_code=404, detail="No packets captured")
    buf = BytesIO()
    pw = PcapWriter(buf, sync=True)
    pw.write(pkts)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.tcpdump.pcap",
        headers={"Content-Disposition": "attachment; filename=capture.pcap"},
    )


# ─── Socket Listener endpoints ────────────────────────────────────────────────

@app.post("/api/listener/start")
async def listener_start(req: ListenerStartRequest):
    ok, msg = packet_gen.start_listener(req.protocol, req.port, req.bind_ip)
    if not ok:
        raise HTTPException(status_code=409, detail=msg)
    return {"status": "ok", "message": msg}


@app.post("/api/listener/stop")
async def listener_stop():
    count = packet_gen.stop_listener()
    return {"status": "ok", "count": count}


@app.get("/api/listener/status")
async def listener_status():
    return {
        "listening": packet_gen.is_listening(),
        "count":     packet_gen.listener_count(),
    }
