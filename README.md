# PktGen

A Docker-based packet generator designed for use in [Containerlab](https://containerlab.dev) topologies and physical lab environments. Built for testing QoS features on Arista EOS — craft and inject raw Ethernet frames with full control over L2 headers, 802.1Q VLAN tags, IP/DSCP markings, and L4 protocol fields, all from a web GUI.

---

## How It Works

```
  ┌─────────────────────────┐          ┌──────────────────────────┐
  │         pktgen          │          │         cEOS node        │
  │                         │          │                          │
  │  eth0 ─── mgmt (clab)  │          │  eth0 ─── mgmt (clab)   │
  │                         │   veth   │                          │
  │  eth1 ─────────────────────────── │  Ethernet1 (trunk)      │
  │         data plane      │          │                          │
  │                         │          │  VLAN classification     │
  │  GUI on :8080 (eth0)   │          │  DSCP / QoS policy       │
  └─────────────────────────┘          └──────────────────────────┘
```

- **eth0** — management interface, managed by Containerlab. Default route and static management routes live here. The web GUI is served on port 8080 via this interface.
- **eth1** — data plane interface, stitched to the cEOS node via a veth pair. All crafted packets go out here.

---

## GUI Features

| Tab / Layer | Fields |
|---|---|
| L2 Ethernet | Source MAC, Destination MAC |
| 802.1Q | VLAN ID (1–4094), PCP/CoS (0–7), toggle on/off |
| L3 IP | Source IP, Destination IP, DSCP (0–63 with named quick-select) |
| L4 Transport | Protocol (UDP / TCP / ICMP), Source Port, Destination Port |
| Transmission | Interface picker, Fixed count or Continuous stream (pps rate) |
| Payload | Custom ASCII string |
| iperf3 | Client/server mode, TCP/UDP, duration, bandwidth, parallel streams, reverse direction |

DSCP quick-select includes all named values: CS0–CS7, AF11–AF43, EF (46).

---

## Build & Push to GHCR

### 1. Authenticate to GitHub Container Registry

```bash
echo "<YOUR_GITHUB_PAT>" | docker login ghcr.io -u <YOUR_GITHUB_USERNAME> --password-stdin
```

Your PAT needs the `write:packages` scope. Create one at **GitHub → Settings → Developer settings → Personal access tokens**.

### 2. Build the image

```bash
docker build -t ghcr.io/bdpost/pktgen:0.0.14 -t ghcr.io/bdpost/pktgen:latest .
```

### 3. Push

```bash
docker push ghcr.io/bdpost/pktgen:0.0.14
docker push ghcr.io/bdpost/pktgen:latest
```

### 4. Make the package public (optional but recommended for clab machines)

**GitHub → Your profile → Packages → pktgen → Package settings → Change visibility → Public**

This lets your clab machine pull without authentication.

---

## Adding to a Containerlab Topology

### Minimal example

```yaml
name: qos-lab

topology:
  nodes:
    pktgen:
      kind: linux
      image: ghcr.io/bdpost/pktgen:latest
      mgmt-ipv4: 172.20.20.10
      cap-add:
        - NET_ADMIN
        - NET_RAW
      ports:
        - "8080:8080/tcp"

    ceos1:
      kind: arista_ceos
      image: ceos:4.32.0F
      mgmt-ipv4: 172.20.20.11
      startup-config: ceos1.cfg

  links:
    - endpoints: ["pktgen:eth1", "ceos1:eth1"]
```

### Full example with multiple VLANs

```yaml
name: qos-lab

topology:
  nodes:
    pktgen:
      kind: linux
      image: ghcr.io/bdpost/pktgen:latest
      mgmt-ipv4: 172.20.20.10
      cap-add:
        - NET_ADMIN
        - NET_RAW
      ports:
        - "8080:8080/tcp"
      env:
        STATIC_ROUTES: "10.0.2.0/24|10.64.254.1|eth0,10.77.7.0/24|10.64.254.1|eth0,10.255.2.0/24|10.64.254.1|eth0"

    ceos1:
      kind: arista_ceos
      image: ceos:4.32.0F
      mgmt-ipv4: 172.20.20.11
      startup-config: ceos1.cfg

  links:
    - endpoints: ["pktgen:eth1", "ceos1:eth1"]
```

> **Note on `privileged`:** Containerlab does not expose a `privileged: true` flag in the topology file. The `NET_ADMIN` + `NET_RAW` capabilities cover everything Scapy needs for raw packet injection. If you hit permission errors, add `SYS_ADMIN` to `cap-add`.

---

## Configuring the cEOS Trunk Port

PktGen sends 802.1Q-tagged frames out `eth1`. The connected cEOS interface must be a trunk. VLAN and QoS policy configuration cannot be set in the Containerlab topology file — it must live in the cEOS `startup-config`.

**`ceos1.cfg` example:**

```
! hostname
hostname ceos1

! Ethernet1 is connected to pktgen eth1
interface Ethernet1
   switchport mode trunk
   switchport trunk allowed vlan 1-4094
!

! VLANs
vlan 100
   name DSCP-TEST-EF
vlan 200
   name DSCP-TEST-AF41
!

! QoS — classify inbound DSCP and map to traffic class
qos map dscp 46 to traffic-class 5        ! EF → TC5
qos map dscp 34 to traffic-class 4        ! AF41 → TC4
qos map dscp 0  to traffic-class 0        ! BE → TC0
!

! Apply inbound QoS on the trunk
interface Ethernet1
   qos trust dscp
!
```

---

## Static Management Routes

Static routes are injected at startup via the `STATIC_ROUTES` environment variable — no image rebuild needed. This is the primary mechanism for management reach-back routes on `eth0`.

### Format

Comma-separated `prefix|nexthop|dev` triplets:

```
prefix/len|next-hop-ip|interface[,prefix/len|next-hop-ip|interface,...]
```

### Setting routes in a Containerlab topology

```yaml
nodes:
  pktgen:
    kind: linux
    image: ghcr.io/bdpost/pktgen:latest
    env:
      STATIC_ROUTES: "10.0.2.0/24|10.64.254.1|eth0,10.77.7.0/24|10.64.254.1|eth0,10.255.2.0/24|10.64.254.1|eth0"
```

Each topology file can specify its own routes — no rebuild required when moving between labs.

### Setting routes in docker-compose (local dev)

Uncomment and edit the `STATIC_ROUTES` line in `docker-compose.yml`:

```yaml
environment:
  - PYTHONUNBUFFERED=1
  - STATIC_ROUTES=10.0.2.0/24|10.64.254.1|eth0,10.77.7.0/24|10.64.254.1|eth0
```

### Adding routes at runtime

Routes can be added, removed, or flushed at any time without restarting the container — either through the GUI (Routes panel) or the API:

```bash
# Add a route
curl -X POST http://<pktgen-ip>:8080/api/routes/add \
  -H "Content-Type: application/json" \
  -d '{"prefix": "10.0.2.0/24", "nexthop": "10.64.254.1", "interface": "eth0"}'

# Remove a route
curl -X POST http://<pktgen-ip>:8080/api/routes/del \
  -H "Content-Type: application/json" \
  -d '{"prefix": "10.0.2.0/24", "nexthop": "10.64.254.1", "interface": "eth0"}'

# Flush all routes on an interface
curl -X POST http://<pktgen-ip>:8080/api/routes/flush \
  -H "Content-Type: application/json" \
  -d '{"interface": "eth0"}'
```

> **Note:** Runtime routes are not persisted. On container restart, only the routes in `STATIC_ROUTES` are re-applied.

---

## Deploying in Containerlab

```bash
# Deploy the topology
clab deploy -t qos-lab.clab.yml

# Check node status and management IPs
clab inspect -t qos-lab.clab.yml

# Tear down
clab destroy -t qos-lab.clab.yml

# Tear down and wipe the clab directory
clab destroy -t qos-lab.clab.yml --cleanup
```

Once deployed, open the GUI at:
```
http://<mgmt-ipv4-of-pktgen>:8080
```

---

## Importing the cEOS Image

cEOS must be obtained from [arista.com](https://www.arista.com) (requires a free account) and imported manually:

```bash
docker import cEOS64-lab-4.32.0F.tar.xz ceos:4.32.0F
```

The image name (`ceos:4.32.0F`) must match what you put in the topology file.

---

## Verifying Packets on the Wire

Inside the container (tcpdump is pre-installed):

```bash
docker exec -it clab-<lab-name>-pktgen tcpdump -i eth1 -n -e -v
```

Or from the cEOS side using EOS CLI:

```
ceos1# bash sudo tcpdump -i eth1 -n -e -v
```

What you'll see for a VLAN-tagged EF packet:

```
de:ad:be:ef:00:01 > ff:ff:ff:ff:ff:ff, ethertype 802.1Q (0x8100), vlan 100, p 0, ...
  IP (tos 0xb8, ...) 10.0.0.1.12345 > 10.0.0.2.80: UDP
```

`tos 0xb8` = `0b10111000` = DSCP 46 (EF) shifted left by 2.

---

## Local Development

Run locally without Containerlab:

```bash
docker compose up -d
```

The container gets its own network namespace (`eth0` + `lo`). Use `lo` as the send interface for smoke-testing the API — no real frames will go anywhere useful, but it confirms the stack works. Access the GUI at `http://localhost:8080`.

```bash
# Tail logs
docker logs -f pktgen-dev

# Shell into the container
docker exec -it pktgen-dev bash

# Stop
docker compose down
```

---

## iperf3 Tab

The **PERF** tab provides a GUI frontend for `iperf3`, which is pre-installed in the container image.

### Client mode

Connect to a remote iperf3 server and run a throughput test.

| Field | Description |
|---|---|
| Target Host | IP or hostname of the remote iperf3 server |
| Port | Server port (default 5201) |
| Protocol | TCP or UDP |
| Duration | Test duration in seconds (default 10) |
| Bandwidth | Target rate for UDP, e.g. `100M`, `1G` — blank = unlimited for TCP |
| Parallel Streams | Number of simultaneous flows (`-P`) |
| Direction | Normal (client → server) or Reverse (server → client, `-R`) |

### Server mode

Start an iperf3 server to accept incoming test connections.

| Field | Description |
|---|---|
| Port | Listening port (default 5201) |
| One-off | Exit after the first client disconnects (`--one-off`) |

### Output

Raw iperf3 output is streamed into the panel's output area in real time. The global LOG panel is not used for iperf3 output since iperf3 produces multi-line tables.

---

## Host Network Mode (Physical Lab / Raspberry Pi)

The default `docker-compose.yml` uses **bridge** network mode, which is correct for Containerlab deployments where eth1 is created and wired by clab as a veth pair.

For standalone Raspberry Pi or bare-metal lab deployments where PktGen needs direct access to the host's physical NICs (e.g. `eth0`, `enx...`), use **host** network mode.

### Why host mode is needed

In bridge mode, the container runs in its own network namespace — physical NICs on the host are not visible inside the container. In host mode, the container shares the host's network namespace, making all physical interfaces directly accessible. This is required for real on-wire traffic generation, iperf3 tests, and raw packet capture against physical links.

### docker-compose.yml change

Edit `docker-compose.yml` and change `network_mode`, removing the `ports:` block (it is incompatible with host mode):

```yaml
services:
  pktgen:
    network_mode: host   # was: bridge
    # Remove or comment out the 'ports:' block
```

Then:

```bash
docker compose up -d
# GUI is available at http://localhost:8080 (no port mapping needed)
```

### docker run command

```bash
docker run -d \
  --name pktgen \
  --network host \
  --cap-add NET_ADMIN \
  --cap-add NET_RAW \
  --privileged \
  --restart unless-stopped \
  -e PYTHONUNBUFFERED=1 \
  ghcr.io/bdpost/pktgen:0.0.14
```

Access the GUI at `http://<host-ip>:8080`.

> **Note:** In host mode the container binds directly on the host's port 8080. Ensure no other service occupies that port.

---

## SSH Access

The container runs an SSH server on port 22. Two accounts are available:

| Username | Password | Notes |
|---|---|---|
| `root` | `clab` | Full root access |
| `admin` | `admin` | Standard user |

### Direct access (requires iptables fix on clab machine)

By default, Docker's FORWARD chain drops inbound connections to container IPs that aren't explicitly published. cEOS nodes work because Containerlab wires their management interface directly to the bridge, bypassing Docker's rules. For linux-kind containers, you need to allow forwarding on the clab machine:

```bash
# Allow all forwarded traffic to the pktgen management subnet (run on the clab machine)
sudo iptables -I DOCKER-USER -d <mgmt-subnet>/24 -j ACCEPT
```

This only needs to be run once per clab machine boot. After that, `ssh root@<mgmt-ipv4>` and `ssh admin@<mgmt-ipv4>` work directly.

### Via port publish (alternative)

Add a port mapping for SSH in the topology file:

```yaml
nodes:
  pktgen:
    kind: linux
    image: ghcr.io/bdpost/pktgen:latest
    ports:
      - "8080:8080/tcp"
      - "2222:22/tcp"    # SSH reachable at clab-machine-ip:2222
```

---

## API Reference

### TX

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/send` | Send a fixed number of packets |
| `POST` | `/api/start` | Start a continuous packet stream |
| `POST` | `/api/stop` | Stop the running stream |
| `GET` | `/api/status` | Stream status + total sent count |
| `GET` | `/api/interfaces` | List interfaces and their MAC addresses |

**Send example:**
```bash
curl -X POST http://localhost:8080/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "src_mac": "de:ad:be:ef:00:01",
    "dst_mac": "ff:ff:ff:ff:ff:ff",
    "src_ip": "10.0.0.1",
    "dst_ip": "10.0.0.2",
    "vlan_id": 100,
    "vlan_pcp": 5,
    "dscp": 46,
    "protocol": "udp",
    "src_port": 1234,
    "dst_port": 5000,
    "count": 10,
    "interface": "eth1"
  }'
```

### Interface

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/interface/up` | Assign an IP to an interface and bring it up |
| `POST` | `/api/interface/down` | Flush address and routes, bring interface down |

```bash
curl -X POST http://localhost:8080/api/interface/up \
  -H "Content-Type: application/json" \
  -d '{"interface": "eth1", "ip": "10.1.1.2/24"}'
```

### Routes

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/routes/add` | Add a static route |
| `POST` | `/api/routes/del` | Delete a static route |
| `POST` | `/api/routes/flush` | Flush all routes on an interface |

```bash
curl -X POST http://localhost:8080/api/routes/add \
  -H "Content-Type: application/json" \
  -d '{"prefix": "10.0.0.0/8", "nexthop": "10.1.1.1", "interface": "eth1"}'
```

### ARP

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/arp/resolve` | Ping a target to populate ARP, return its MAC |

```bash
curl -X POST http://localhost:8080/api/arp/resolve \
  -H "Content-Type: application/json" \
  -d '{"ip": "10.1.1.1", "interface": "eth1"}'
```

### RX

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/rx/start` | Start capturing packets on an interface |
| `POST` | `/api/rx/stop` | Stop capturing |
| `GET` | `/api/rx/packets` | Fetch captured packets (optional `?since=<seq>`) |
| `DELETE` | `/api/rx/packets` | Clear the captured packet buffer |

### Socket Listener

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/listener/start` | Start a TCP/UDP socket listener |
| `POST` | `/api/listener/stop` | Stop the listener |
| `GET` | `/api/listener/status` | Listener state + connection count |

### iperf3

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/iperf3/start` | Start iperf3 in client or server mode |
| `POST` | `/api/iperf3/stop` | Stop the running iperf3 process |
| `GET` | `/api/iperf3/output` | Fetch output lines (optional `?since=<N>`) + running state |

**Start example (client):**
```bash
curl -X POST http://localhost:8080/api/iperf3/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"client","host":"10.1.1.1","port":5201,"protocol":"tcp","duration":10}'
```

**Start example (server):**
```bash
curl -X POST http://localhost:8080/api/iperf3/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"server","port":5201}'
```

**Poll output:**
```bash
curl "http://localhost:8080/api/iperf3/output?since=0"
```

---

## Project Structure

```
PktGen/
├── Dockerfile
├── docker-compose.yml        # Local dev
├── entrypoint.sh             # Route injection + uvicorn start
├── app/
│   ├── main.py               # FastAPI app + API routes
│   ├── packet_gen.py         # Scapy packet engine
│   └── requirements.txt
└── static/
    ├── index.html
    ├── style.css
    └── app.js
```
