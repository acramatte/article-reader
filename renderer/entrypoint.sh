#!/bin/sh
set -eu
# Fail closed. Only the public-only proxy is a new outbound TCP destination.
# No Docker DNS, direct public internet, localhost, metadata, host bridge, or
# renderer-control sockets. Replies to fixed relay ingress remain allowed.
iptables -P OUTPUT DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p tcp -d 172.30.197.2 --dport 3128 -j ACCEPT
iptables -P INPUT DROP
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp -s 172.30.197.2 --dport 3002 -j ACCEPT
ip6tables -P OUTPUT DROP
ip6tables -P INPUT DROP
# Drop ALL capabilities before running Node/Chromium (including bounding set).
# Keep no-new-privileges; sandbox uses unprivileged user namespaces, not setuid.
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all node renderer/service.mjs
