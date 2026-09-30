#!/usr/bin/env bash
set -euo pipefail

# Build and deploy this checkout to a small Azure Linux VM for Apple cloud
# testing. SQLite and Maple config live on the VM's OS disk in /var/lib/maple.
# The script requires Azure CLI login, Docker is installed on the VM, and
# SSH/scp are used to transfer committed sources without requiring GitHub access.

REGION="${MAPLE_AZURE_REGION:-eastus}"
SUFFIX="$(openssl rand -hex 3)"
RESOURCE_GROUP="${MAPLE_AZURE_RESOURCE_GROUP:-maple-apple-dev-${SUFFIX}}"
VM_NAME="${MAPLE_AZURE_VM_NAME:-maple-apple-${SUFFIX}}"
NSG_NAME="${MAPLE_AZURE_NSG_NAME:-${VM_NAME}-nsg}"
PUBLIC_IP_NAME="${VM_NAME}-ip"
DNS_LABEL="${MAPLE_AZURE_DNS_LABEL:-${VM_NAME}}"
ADMIN_USER="${MAPLE_AZURE_ADMIN_USER:-maple}"
BUILD_SIZE="${MAPLE_AZURE_BUILD_SIZE:-Standard_B2s}"
RUNTIME_SIZE="${MAPLE_AZURE_RUNTIME_SIZE:-Standard_B2s}"
ROOT="$(git rev-parse --show-toplevel)"
SSH_KEY="${MAPLE_AZURE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_PUB_KEY="${SSH_KEY}.pub"
ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/maple-apple-dev.XXXXXX")"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -i "$SSH_KEY")

cleanup() { rm -f "$ARCHIVE"; }
trap cleanup EXIT

command -v az >/dev/null || {
	echo "Azure CLI (az) is required." >&2
	exit 1
}
command -v ssh >/dev/null || {
	echo "ssh is required." >&2
	exit 1
}
command -v scp >/dev/null || {
	echo "scp is required." >&2
	exit 1
}
az account show --output none

if [[ ! -f "$SSH_KEY" ]]; then
	mkdir -p "$(dirname "$SSH_KEY")"
	ssh-keygen -t ed25519 -N '' -f "$SSH_KEY" -C "maple-apple-dev-${SUFFIX}"
fi
if [[ ! -f "$SSH_PUB_KEY" ]]; then
	ssh-keygen -y -f "$SSH_KEY" >"$SSH_PUB_KEY"
fi

SOURCE_IP="$(curl -4fsS https://api.ipify.org)"
WEB_SOURCE="${SOURCE_IP}/32"
az group create --name "$RESOURCE_GROUP" --location "$REGION" --output none
az network nsg create --resource-group "$RESOURCE_GROUP" --name "$NSG_NAME" --location "$REGION" --output none
az network nsg rule create --resource-group "$RESOURCE_GROUP" --nsg-name "$NSG_NAME" \
	--name maple-ssh-from-setup-machine --priority 100 --direction Inbound --access Allow \
	--protocol Tcp --source-address-prefixes "${SOURCE_IP}/32" --source-port-ranges '*' \
	--destination-address-prefixes '*' --destination-port-ranges 22 --output none
# Caddy answers HTTP with an HTTPS redirect; ACME needs public port 80.
az network nsg rule create --resource-group "$RESOURCE_GROUP" --nsg-name "$NSG_NAME" \
	--name maple-acme-http --priority 105 --direction Inbound --access Allow --protocol Tcp \
	--source-address-prefixes Internet --source-port-ranges '*' --destination-address-prefixes '*' \
	--destination-port-ranges 80 --output none
az network nsg rule create --resource-group "$RESOURCE_GROUP" --nsg-name "$NSG_NAME" \
	--name maple-public-web --priority 110 --direction Inbound --access Allow --protocol Tcp \
	--source-address-prefixes "$WEB_SOURCE" --source-port-ranges '*' --destination-address-prefixes '*' \
	--destination-port-ranges 443 --output none

az vm create --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --location "$REGION" \
	--image Ubuntu2404 --size "$BUILD_SIZE" --admin-username "$ADMIN_USER" \
	--ssh-key-values "$SSH_PUB_KEY" --nsg "$NSG_NAME" --nsg-rule NONE \
	--public-ip-sku Standard --public-ip-address "$PUBLIC_IP_NAME" \
	--public-ip-address-dns-name "$DNS_LABEL" --os-disk-size-gb 64 --storage-sku StandardSSD_LRS \
	--output none

PUBLIC_IP="$(az vm show -d --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --query publicIps -o tsv)"
HOSTNAME="$(az vm show -d --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --query fqdns -o tsv)"
[[ -n "$HOSTNAME" ]] || HOSTNAME="${DNS_LABEL}.${REGION}.cloudapp.azure.com"
[[ "$HOSTNAME" =~ ^[a-zA-Z0-9.-]+$ ]] || {
	echo "Invalid Azure hostname" >&2
	exit 1
}

echo "Waiting for SSH on ${PUBLIC_IP}..."
for attempt in $(seq 1 90); do
	if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=3 "${ADMIN_USER}@${PUBLIC_IP}" 'true' >/dev/null 2>&1; then break; fi
	if [[ "$attempt" == 90 ]]; then
		echo "SSH did not become available." >&2
		exit 1
	fi
	sleep 5
done

ssh "${SSH_OPTS[@]}" "${ADMIN_USER}@${PUBLIC_IP}" 'sudo cloud-init status --wait && sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 docker-buildx && sudo systemctl enable --now docker && sudo usermod -aG docker "$USER" && sudo fallocate -l 6G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile && echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null && sudo mkdir -p /opt/maple /var/lib/maple/data /var/lib/maple/config && sudo chown -R "$USER":"$USER" /opt/maple /var/lib/maple'

# Include only committed repository files; never upload local databases,
# credentials, environment files, or ignored build output from this machine.
git -C "$ROOT" archive --format=tar.gz --output="$ARCHIVE" HEAD \
	src/api src/web src/raw-pipeline src/maple resources/film-luts
scp "${SSH_OPTS[@]}" "$ARCHIVE" "${ADMIN_USER}@${PUBLIC_IP}:/tmp/maple-apple-dev.tgz"

# The validated Azure hostname is intentionally expanded on this machine.
# shellcheck disable=SC2029
ssh "${SSH_OPTS[@]}" "${ADMIN_USER}@${PUBLIC_IP}" "bash -s -- '$HOSTNAME' <<'REMOTE'
set -euo pipefail
HOSTNAME=\$1
tar --warning=no-unknown-keyword -xzf /tmp/maple-apple-dev.tgz -C /opt/maple
cd /opt/maple
docker buildx build --load -f src/api/Dockerfile -t maple:apple-dev .
cat > /opt/maple/Caddyfile <<CADDY
\$HOSTNAME {
  encode zstd gzip
  reverse_proxy maple:3000
}
CADDY
cat > /opt/maple/compose.yaml <<COMPOSE
services:
  maple:
    image: maple:apple-dev
    restart: unless-stopped
    expose: ['3000']
    environment:
      PORT: '3000'
      MAPLE_SQLITE_PATH: /app/data/maple.sqlite
      MAPLE_RP_ID: '$HOSTNAME'
      MAPLE_ORIGIN: 'https://$HOSTNAME'
    volumes:
      - /var/lib/maple/data:/app/data
      - /var/lib/maple/config:/app/config
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ['80:80', '443:443', '443:443/udp']
    volumes:
      - /opt/maple/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [maple]
volumes:
  caddy_data:
  caddy_config:
COMPOSE
docker compose -f compose.yaml up -d
rm -f /tmp/maple-apple-dev.tgz
REMOTE"

if [[ "$RUNTIME_SIZE" != "$BUILD_SIZE" ]]; then
	az vm deallocate --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --output none
	az vm resize --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --size "$RUNTIME_SIZE" --output none
	az vm start --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --output none
fi

cat <<INFO

Apple dev server deployed.
URL: https://${HOSTNAME}
Resource group: ${RESOURCE_GROUP}
VM: ${VM_NAME} (${RUNTIME_SIZE})
SQLite database: /var/lib/maple/data/maple.sqlite

Claim the owner account from this setup machine with a passkey and no invite code. Then open the
URL for testing, and create an invite code in Settings → Users.
Copy and share the code with the new member; it is single-use and expires after 15 minutes. SSH and HTTPS initially allow only
${SOURCE_IP}/32. After the owner account is claimed, open web access with:
  az network nsg rule update --resource-group ${RESOURCE_GROUP} --nsg-name ${NSG_NAME} --name maple-public-web --source-address-prefixes Internet
INFO
