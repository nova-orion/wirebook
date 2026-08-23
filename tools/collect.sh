#!/bin/sh
# Collects facts that can be turned into inventory. Run the section that matches
# the box you are on; each writes one file into $OUT.
#
#   OUT=~/wirebook-import sh collect.sh linux
#
# Nothing here reads a secret. It deliberately does NOT touch pfSense config.xml
# or any Ansible vault: those carry credentials, and none of what is needed to
# describe hardware and cabling lives in them.
#
# What each source can and cannot tell you:
#
#   proxmox / linux  specs, drives, NIC names and MACs, link speeds, guests
#   pfsense          VLANs, subnets, which NIC is which, MAC <-> IP <-> hostname
#   unifi            which switch port each MAC is on. This is the actual cabling.
#   lldp             the same thing from the host's side, if the switch speaks it
#
#   an unmanaged switch is invisible. Anything behind it can only be placed by
#   hand, because nothing on the network can see which of its ports you used.
set -eu

OUT="${OUT:-./wirebook-import}"
mkdir -p "$OUT"
host="$(hostname -s 2>/dev/null || hostname)"
say() { printf '  %s\n' "$1"; }

collect_linux() {
  say "specs -> $OUT/$host.specs.txt"
  {
    echo "== hostname =="; hostname -f 2>/dev/null || hostname
    echo; echo "== system =="
    # vendor/model/serial/motherboard, for meta.vendor/model/serial/motherboard
    (sudo dmidecode -s system-manufacturer; sudo dmidecode -s system-product-name;
     sudo dmidecode -s system-serial-number; sudo dmidecode -s baseboard-product-name;
     sudo dmidecode -s bios-version) 2>/dev/null || echo "(dmidecode needs root)"
    echo; echo "== cpu =="; lscpu 2>/dev/null | grep -Ei 'model name|^cpu\(s\)|core|thread'
    echo; echo "== memory =="; free -g 2>/dev/null | head -2
    echo; echo "== drives =="   # -> meta.capacity, serial, rpm
    lsblk -dno NAME,SIZE,MODEL,SERIAL,ROTA 2>/dev/null
    echo; echo "== nics =="   # -> one pluggable per NIC, with mac and speed
    ip -br link 2>/dev/null
    echo; echo "== addresses =="; ip -br addr 2>/dev/null
    echo; echo "== link speeds =="
    for i in $(ls /sys/class/net 2>/dev/null); do
      [ "$i" = lo ] && continue
      s=$(cat "/sys/class/net/$i/speed" 2>/dev/null || echo '?')
      printf '%s %s Mb/s\n' "$i" "$s"
    done
    echo; echo "== pci ethernet =="; lspci 2>/dev/null | grep -i -E 'ethernet|network'
  } > "$OUT/$host.specs.txt" 2>&1
}

collect_neighbours() {
  say "neighbours -> $OUT/$host.neighbours.txt"
  {
    echo "== arp / neighbours =="   # -> mac <-> ip, to identify devices
    ip neigh 2>/dev/null || arp -an 2>/dev/null
    echo; echo "== bridge fdb =="   # which MACs are seen behind which bridge port
    bridge fdb show 2>/dev/null | grep -v permanent | head -100
    echo; echo "== lldp =="         # -> the switch and PORT this host is cabled to
    (lldpctl -f keyvalue 2>/dev/null || lldpcli show neighbors 2>/dev/null) \
      || echo "(no lldpd; install it and this tells you the exact switch port)"
  } > "$OUT/$host.neighbours.txt" 2>&1
}

collect_proxmox() {
  collect_linux
  collect_neighbours
  say "guests -> $OUT/$host.guests.txt"
  {
    echo "== node status =="; pvesh get /nodes/"$host"/status --output-format yaml 2>/dev/null
    echo; echo "== guests =="    # -> one virtual: true node per VM, parent = this host
    qm list 2>/dev/null
    echo; echo "== containers =="; pct list 2>/dev/null
    echo; echo "== guest configs =="
    for id in $(qm list 2>/dev/null | awk 'NR>1{print $1}'); do
      echo "--- vm $id ---"; qm config "$id" 2>/dev/null | grep -Ei 'name|memory|cores|net[0-9]|bridge'
    done
    echo; echo "== bridges =="; ip -br link show type bridge 2>/dev/null
  } > "$OUT/$host.guests.txt" 2>&1
}

# pfSense is FreeBSD. Run over ssh, or paste these into Diagnostics > Command Prompt.
collect_pfsense() {
  say "pfsense -> $OUT/pfsense.txt"
  {
    echo "== interfaces =="      # which igc/em NIC is WAN, LAN, trunk
    ifconfig -a
    echo; echo "== vlans =="     # -> the top-level vlans: block
    ifconfig -a | grep -A2 vlan
    echo; echo "== arp =="       # -> mac <-> ip for everything on the network
    arp -an
    echo; echo "== ndp =="; ndp -an 2>/dev/null
    echo; echo "== dhcp leases =="   # -> mac <-> ip <-> hostname
    cat /var/dhcpd/var/db/dhcpd.leases 2>/dev/null | grep -E 'lease|hardware|client-hostname'
    echo; echo "== routes =="; netstat -rn
  } > "$OUT/pfsense.txt" 2>&1
  say "NOTE: do not export config.xml for this. It contains password hashes and keys."
}

# The one source that knows actual cabling: which switch port each MAC is on.
# Set UNIFI_URL / UNIFI_USER / UNIFI_PASS in the environment; they are never written out.
collect_unifi() {
  : "${UNIFI_URL:?set UNIFI_URL, e.g. https://unifi.example.internal:8443}"
  : "${UNIFI_USER:?set UNIFI_USER}"
  : "${UNIFI_PASS:?set UNIFI_PASS}"
  jar=$(mktemp); trap 'rm -f "$jar"' EXIT
  say "unifi -> $OUT/unifi.devices.json and $OUT/unifi.clients.json"

  # self-hosted controller first, then UniFi OS paths
  if curl -sk -c "$jar" -X POST "$UNIFI_URL/api/login" \
       -H 'Content-Type: application/json' \
       -d "{\"username\":\"$UNIFI_USER\",\"password\":\"$UNIFI_PASS\"}" >/dev/null 2>&1 &&
     curl -sfk -b "$jar" "$UNIFI_URL/api/s/default/stat/device" -o "$OUT/unifi.devices.json"; then
    curl -sfk -b "$jar" "$UNIFI_URL/api/s/default/stat/sta" -o "$OUT/unifi.clients.json"
  else
    curl -sk -c "$jar" -X POST "$UNIFI_URL/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"$UNIFI_USER\",\"password\":\"$UNIFI_PASS\"}" >/dev/null
    curl -sfk -b "$jar" "$UNIFI_URL/proxy/network/api/s/default/stat/device" -o "$OUT/unifi.devices.json"
    curl -sfk -b "$jar" "$UNIFI_URL/proxy/network/api/s/default/stat/sta" -o "$OUT/unifi.clients.json"
  fi
  say "clients carry sw_mac + sw_port, which is the switch and the port number: that is the cable"
}

case "${1:-}" in
  linux)    collect_linux; collect_neighbours ;;
  proxmox)  collect_proxmox ;;
  pfsense)  collect_pfsense ;;
  unifi)    collect_unifi ;;
  *)
    cat <<'USAGE'
usage: OUT=<dir> sh collect.sh <linux|proxmox|pfsense|unifi>

  proxmox   run on each Proxmox host: specs, drives, NICs, MACs, guests
  linux     run on any other Linux box: the same minus guests
  pfsense   run on pfSense: VLANs, interface roles, ARP, DHCP leases
  unifi     run anywhere with curl: which switch port each MAC is on

Run proxmox on every hypervisor, pfsense once, unifi once. Then point the
importer at OUT. An unmanaged switch cannot be discovered by any of these.
USAGE
    exit 2 ;;
esac
say "done -> $OUT"
