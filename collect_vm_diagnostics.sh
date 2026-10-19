#!/usr/bin/env bash

# Collect a privacy-conscious diagnostic bundle after restoring a Linux VM.
# Intended for Ubuntu/Debian systems, but most checks are distribution-neutral.

set -u
set -o pipefail

export LANG=C
export LC_ALL=C
export SYSTEMD_COLORS=0
export SYSTEMD_PAGER=cat
export PAGER=cat

SCRIPT_NAME="$(basename -- "$0")"

usage() {
  printf 'Usage: %s [APPLICATION_DIRECTORY]\n' "$SCRIPT_NAME"
  printf '\n'
  printf 'Collects system, storage, boot, service, network, SSH, backup-agent,\n'
  printf 'Docker and application metadata into a redacted .tar.gz archive.\n'
  printf 'Application logs, .env files, private keys and process environments\n'
  printf 'are deliberately excluded.\n'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if (( EUID != 0 )); then
  printf 'Root access is needed for complete diagnostics; restarting with sudo.\n' >&2
  exec sudo bash "$0" "$@"
fi

APP_DIR_INPUT="${1:-$PWD}"
if [[ ! -d "$APP_DIR_INPUT" ]]; then
  printf 'Application directory does not exist: %s\n' "$APP_DIR_INPUT" >&2
  exit 2
fi

APP_DIR="$(cd -- "$APP_DIR_INPUT" && pwd -P)"
OUTPUT_DIR="$PWD"
HOST_SHORT="$(hostname -s 2>/dev/null || printf 'unknown-host')"
HOST_SAFE="${HOST_SHORT//[^A-Za-z0-9._-]/_}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUNDLE_NAME="vm-diagnostics-${HOST_SAFE}-${TIMESTAMP}"
WORK_DIR="$(mktemp -d "/tmp/${BUNDLE_NAME}.XXXXXX")"
BUNDLE_DIR="$WORK_DIR/$BUNDLE_NAME"
ARCHIVE_PATH="$OUTPUT_DIR/${BUNDLE_NAME}.tar.gz"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"
ORIGINAL_USER="${SUDO_USER:-root}"

mkdir -p -- "$BUNDLE_DIR"
chmod 700 -- "$WORK_DIR" "$BUNDLE_DIR"

cleanup() {
  if [[ -n "${WORK_DIR:-}" && "$WORK_DIR" == /tmp/vm-diagnostics-* ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

record() {
  local output_file="$1"
  shift
  {
    printf 'collected_utc=%s\n' "$(date -u --iso-8601=seconds)"
    printf 'command='
    printf '%q ' "$@"
    printf '\n\n'
    timeout 180 "$@"
    local command_status=$?
    printf '\nexit_code=%s\n' "$command_status"
  } >"$BUNDLE_DIR/$output_file" 2>&1
  return 0
}

record_shell() {
  local output_file="$1"
  local shell_code="$2"
  {
    printf 'collected_utc=%s\n\n' "$(date -u --iso-8601=seconds)"
    timeout 180 bash -o pipefail -c "$shell_code"
    local command_status=$?
    printf '\nexit_code=%s\n' "$command_status"
  } >"$BUNDLE_DIR/$output_file" 2>&1
  return 0
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

printf 'Collecting VM diagnostics into a temporary directory...\n'

{
  printf 'VM RESTORE DIAGNOSTIC BUNDLE\n'
  printf '============================\n\n'
  printf 'Created (UTC): %s\n' "$(date -u --iso-8601=seconds)"
  printf 'Hostname: %s\n' "$HOST_SHORT"
  printf 'Application directory: %s\n' "$APP_DIR"
  printf 'Collector: %s\n\n' "$SCRIPT_NAME"
  printf 'Privacy notes:\n'
  printf -- '- No environment-variable dump was collected.\n'
  printf -- '- No .env contents, private keys or authorized_keys contents were collected.\n'
  printf -- '- Docker/container environment and full application logs were excluded.\n'
  printf -- '- Typical secrets in collected text were redacted before packaging.\n'
  printf -- '- The archive can still contain usernames, hostnames, internal IPs,\n'
  printf '  file names, listening ports and fragments of system journals.\n'
} >"$BUNDLE_DIR/README.txt"

# Host, OS, clock, boot and virtualization.
record 01-uname.txt uname -a
record 02-os-release.txt sh -c 'test -r /etc/os-release && cat /etc/os-release'
record 03-hostnamectl.txt hostnamectl
record 04-time.txt timedatectl
record_shell 05-uptime-and-boot.txt '
  date --iso-8601=seconds
  date -u --iso-8601=seconds
  uptime
  uptime -s
  who -b || true
  last reboot -n 10 || true
'
record_shell 06-virtualization.txt '
  systemd-detect-virt || true
  command -v cloud-id >/dev/null 2>&1 && cloud-id || true
  test -r /sys/class/dmi/id/product_name && sed -n "1p" /sys/class/dmi/id/product_name
  test -r /sys/class/dmi/id/sys_vendor && sed -n "1p" /sys/class/dmi/id/sys_vendor
'

# Storage layout and filesystem state. No offline fsck is attempted.
record 10-lsblk.txt lsblk -e 7 -o NAME,KNAME,TYPE,FSTYPE,FSVER,LABEL,UUID,PARTUUID,SIZE,FSAVAIL,FSUSE%,RO,MOUNTPOINTS
record 11-blkid.txt blkid
record 12-disk-space.txt df -hT
record 13-inode-space.txt df -ih
record 14-findmnt.txt findmnt --all --real --output SOURCE,TARGET,FSTYPE,OPTIONS,UUID
record 15-findmnt-verify.txt findmnt --verify --verbose
record 16-fstab.txt sh -c 'test -r /etc/fstab && cat /etc/fstab'
record 17-swap.txt swapon --show --output NAME,TYPE,SIZE,USED,PRIO
record_shell 18-ext-filesystem-metadata.txt '
  findmnt -rn -t ext2,ext3,ext4 -o SOURCE | while IFS= read -r device; do
    printf "===== %s =====\n" "$device"
    tune2fs -l "$device" 2>&1 || true
  done
'

# Kernel and recent boot messages.
record 20-kernel-cmdline.txt sh -c 'test -r /proc/cmdline && cat /proc/cmdline'
record 21-dmesg-errors-warnings.txt dmesg --ctime --level=err,warn
record 22-loaded-modules.txt lsmod
record_shell 23-kernel-packages.txt '
  uname -r
  command -v dkms >/dev/null 2>&1 && dkms status || true
  if command -v dpkg-query >/dev/null 2>&1; then
    dpkg-query -W -f="${binary:Package}\t${Version}\t${db:Status-Abbrev}\n" \
      "linux-image*" "linux-modules*" 2>&1 || true
  fi
'
record_shell 24-cpu-vulnerabilities.txt '
  if test -d /sys/devices/system/cpu/vulnerabilities; then
    for file in /sys/devices/system/cpu/vulnerabilities/*; do
      test -f "$file" || continue
      printf "%s: " "$(basename "$file")"
      cat "$file"
    done
  fi
'

# systemd state and bounded journal diagnostics.
record 30-failed-units.txt systemctl --failed --all --no-pager --full
record 31-running-services.txt systemctl list-units --type=service --state=running --no-pager --full
record 32-enabled-services.txt systemctl list-unit-files --type=service --state=enabled --no-pager --full
record 33-all-timers.txt systemctl list-timers --all --no-pager --full
record 34-systemd-critical-chain.txt systemd-analyze critical-chain
record 35-systemd-blame.txt systemd-analyze blame
record 36-current-boot-errors.txt journalctl -b -p err --no-pager -n 2000 -o short-iso-precise
record 37-journal-boots.txt journalctl --list-boots --no-pager
record 38-journal-disk-usage.txt journalctl --disk-usage
record 39-journal-verify.txt journalctl --verify
record 40-coredumps.txt coredumpctl list --no-pager

# Resource snapshot without process command-line arguments or environments.
record 45-memory.txt free -h
record 46-vmstat.txt vmstat 1 5
record_shell 47-processes.txt '
  ps -eo user:24,pid,ppid,stat,%cpu,%mem,lstart,comm --sort=-%mem | head -n 250
'

# Networking. This intentionally avoids external requests and cloud metadata.
record 50-ip-addresses.txt ip -brief address show
record 51-ip-routes.txt ip route show table all
record 52-ip-rules.txt ip rule show
record 53-listening-sockets.txt ss -lntup
if command_exists resolvectl; then
  record 54-dns.txt resolvectl status
else
  record 54-dns.txt sh -c 'test -r /etc/resolv.conf && cat /etc/resolv.conf'
fi
if command_exists ufw; then
  record 55-firewall-ufw.txt ufw status verbose
fi
if command_exists nft; then
  record 56-firewall-nft.txt nft list ruleset
fi

# SSH configuration and fingerprints only. Key contents are never copied.
if command_exists sshd; then
  record 60-sshd-effective-config.txt sshd -T
fi
record_shell 61-ssh-host-key-fingerprints.txt '
  for key in /etc/ssh/ssh_host_*_key.pub; do
    test -f "$key" || continue
    ssh-keygen -lf "$key" 2>&1 || true
  done
'
export DIAG_LOGIN="$ORIGINAL_USER"
record_shell 62-login-user-and-ssh-metadata.txt '
  getent passwd "$DIAG_LOGIN" | awk -F: "{print \$1 \":\" \$3 \":\" \$4 \":\" \$6 \":\" \$7}" || true
  login_home="$(getent passwd "$DIAG_LOGIN" | cut -d: -f6)"
  if test -n "$login_home" && test -d "$login_home/.ssh"; then
    stat -c "%A %a %U:%G %s %y %n" "$login_home" "$login_home/.ssh" 2>&1 || true
    if test -f "$login_home/.ssh/authorized_keys"; then
      stat -c "%A %a %U:%G %s %y %n" "$login_home/.ssh/authorized_keys" 2>&1 || true
      sha256sum "$login_home/.ssh/authorized_keys" 2>&1 || true
      ssh-keygen -lf "$login_home/.ssh/authorized_keys" 2>&1 \
        | awk "{print \$1, \$2, \$NF}" || true
    fi
  fi
'

# Cloud-init status only; raw cloud-init logs may contain user-data output.
if command_exists cloud-init; then
  record 65-cloud-init-status.txt cloud-init status --long
fi
record_shell 66-cloud-init-units.txt '
  systemctl list-units --all --no-pager --full | grep -Ei "cloud-(init|config|final)" || true
'

# Backup/Acronis agent. File names and service logs are collected, not configs.
record_shell 70-backup-agent-services.txt '
  systemctl list-units --type=service --all --no-pager --full \
    | grep -Ei "acronis|backup|cyber|adp-agent" || true
  systemctl list-unit-files --type=service --no-pager --full \
    | grep -Ei "acronis|backup|cyber|adp-agent" || true
'
record_shell 71-backup-agent-processes.txt '
  ps -eo user:24,pid,ppid,stat,lstart,comm \
    | grep -Ei "acronis|backup|cyber|adp-agent|mms|snapapi" || true
'
record_shell 72-backup-agent-packages.txt '
  if command -v dpkg-query >/dev/null 2>&1; then
    dpkg-query -W -f="${binary:Package}\t${Version}\t${db:Status-Abbrev}\n" 2>/dev/null \
      | grep -Ei "acronis|backup|cyber|snapapi" || true
  elif command -v rpm >/dev/null 2>&1; then
    rpm -qa | grep -Ei "acronis|backup|cyber|snapapi" || true
  fi
'
record_shell 73-snapapi-module.txt '
  lsmod | grep -Ei "snapapi" || true
  modinfo snapapi26 2>&1 || true
'
record_shell 74-backup-agent-files.txt '
  for root in /opt/acronis /usr/lib/Acronis /var/lib/Acronis; do
    test -d "$root" || continue
    printf "===== %s =====\n" "$root"
    find "$root" -xdev -maxdepth 3 -printf "%M %u:%g %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n" \
      2>&1 | sort
  done
'
record_shell 75-backup-agent-journal.txt '
  systemctl list-units --type=service --all --no-legend --plain \
    | awk "tolower(\$1) ~ /(acronis|backup|cyber|adp-agent)/ {print \$1}" \
    | sort -u \
    | while IFS= read -r unit; do
        test -n "$unit" || continue
        printf "===== STATUS %s =====\n" "$unit"
        systemctl status "$unit" --no-pager --full 2>&1 || true
        printf "===== JOURNAL %s =====\n" "$unit"
        journalctl -u "$unit" -b --no-pager -n 500 -o short-iso-precise 2>&1 || true
      done
'

# Package database health and a reproducible package inventory.
if command_exists dpkg; then
  record 80-dpkg-audit.txt dpkg --audit
  record 81-installed-packages.txt dpkg-query -W '-f=${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n'
elif command_exists rpm; then
  record 81-installed-packages.txt rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\n'
fi

# Cron file metadata only; cron command contents may contain embedded secrets.
record_shell 82-scheduled-jobs-metadata.txt '
  for path in /etc/crontab /etc/cron.d /etc/cron.hourly /etc/cron.daily \
              /etc/cron.weekly /etc/cron.monthly /var/spool/cron/crontabs; do
    test -e "$path" || continue
    printf "===== %s =====\n" "$path"
    if test -d "$path"; then
      find "$path" -xdev -maxdepth 1 -printf "%M %u:%g %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n" 2>&1 | sort
    else
      stat -c "%A %a %U:%G %s %y %n" "$path" 2>&1 || true
    fi
  done
'

# Docker metadata. Container inspection, environment and application logs are excluded.
if command_exists docker; then
  record 90-docker-version.txt docker version
  record_shell 91-docker-summary.txt '
    docker info --format "ServerVersion={{.ServerVersion}} Driver={{.Driver}} CgroupDriver={{.CgroupDriver}} Containers={{.Containers}} Running={{.ContainersRunning}} Paused={{.ContainersPaused}} Stopped={{.ContainersStopped}} Images={{.Images}}" 2>&1 || true
    docker ps -a --no-trunc --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>&1 || true
    docker volume ls 2>&1 || true
    docker network ls 2>&1 || true
    docker system df 2>&1 || true
  '
fi

# Application/repository metadata. File contents and diffs are not collected.
export DIAG_APP_DIR="$APP_DIR"
record_shell 100-application-directory.txt '
  printf "application_directory=%s\n" "$DIAG_APP_DIR"
  stat -c "%A %a %U:%G %s %y %n" "$DIAG_APP_DIR" 2>&1 || true
  du -x -h -d 2 "$DIAG_APP_DIR" 2>&1 | sort -h | tail -n 200
  printf "\n===== FILE METADATA (MAX DEPTH 3) =====\n"
  find "$DIAG_APP_DIR" -xdev -maxdepth 3 \
    \( -name .git -o -name node_modules -o -name .venv -o -name venv \
       -o -name __pycache__ -o -name .mypy_cache -o -name .pytest_cache \) -prune \
    -o -printf "%M %u:%g %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n" 2>&1 \
    | sort | tail -n 3000
'

if command_exists git && git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  record_shell 101-git-state.txt '
    git -C "$DIAG_APP_DIR" rev-parse --show-toplevel
    git -C "$DIAG_APP_DIR" rev-parse HEAD
    git -C "$DIAG_APP_DIR" branch --show-current
    git -C "$DIAG_APP_DIR" status --short --branch
    git -C "$DIAG_APP_DIR" log -n 20 --date=iso-strict --pretty="format:%H%x09%ad%x09%s"
    printf "\n===== DIFF STAT ONLY =====\n"
    git -C "$DIAG_APP_DIR" diff --stat
    git -C "$DIAG_APP_DIR" diff --cached --stat
  '
fi

if command_exists docker && [[ -f "$APP_DIR/compose.yaml" || -f "$APP_DIR/compose.yml" || -f "$APP_DIR/docker-compose.yaml" || -f "$APP_DIR/docker-compose.yml" ]]; then
  record_shell 102-docker-compose-state.txt '
    cd -- "$DIAG_APP_DIR"
    docker compose ps -a 2>&1 || true
    printf "\n===== SERVICES =====\n"
    docker compose config --services 2>&1 || true
    printf "\n===== IMAGES =====\n"
    docker compose config --images 2>&1 || true
  '
fi

# Redact common secrets from every collected text file before packaging.
printf 'Redacting common secret patterns...\n'
while IFS= read -r -d '' text_file; do
  perl -i -pe '
    s{(Authorization\s*:\s*(?:Bearer|Basic)\s+)\S+}{$1[REDACTED]}ig;
    s{((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*)[^\s,;]+}{$1[REDACTED]}ig;
    s{\b(?:AQAD-|y[01]_|t[01]_)[A-Za-z0-9._~+\/-]{8,}}{[REDACTED_TOKEN]}g;
    s{(https?://)[^/\s:@]+:[^@\s/]+@}{$1[REDACTED]@}ig;
    s{([?&](?:X-Amz-[^=&]+|X-Goog-[^=&]+|Signature|sig|token|credential|key|auth)=)[^&#\s]+}{$1[REDACTED]}ig;
  ' "$text_file" 2>/dev/null || true
done < <(find "$BUNDLE_DIR" -type f -print0)

printf 'Creating archive...\n'
tar -C "$WORK_DIR" -czf "$ARCHIVE_PATH" "$BUNDLE_NAME"
chmod 600 -- "$ARCHIVE_PATH"
sha256sum "$ARCHIVE_PATH" >"$CHECKSUM_PATH"
chmod 600 -- "$CHECKSUM_PATH"

if [[ "$ORIGINAL_USER" != root ]] && id "$ORIGINAL_USER" >/dev/null 2>&1; then
  chown "$ORIGINAL_USER":"$(id -gn "$ORIGINAL_USER")" "$ARCHIVE_PATH" "$CHECKSUM_PATH" 2>/dev/null || true
fi

printf '\nDone. Upload these files:\n'
printf '  %s\n' "$ARCHIVE_PATH"
printf '  %s\n' "$CHECKSUM_PATH"
printf '\nArchive contents can be reviewed with:\n'
printf '  tar -tzf %q\n' "$ARCHIVE_PATH"
printf '\nTreat the archive as sensitive: it contains system metadata and journal excerpts.\n'
