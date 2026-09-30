#!/usr/bin/env bash
set -euo pipefail

# The manual workflow manages this one dedicated test server. The empty
# resource group stays in place so its scoped Azure role survives deletion.
ACTION="${1:-}"
RESOURCE_GROUP=maple-apple-dev-75ffbb
VM_NAME=maple-apple-75ffbb
ROOT="$(git rev-parse --show-toplevel)"

case "$ACTION" in
create | delete | recreate) ;;
*)
	echo 'Expected create, delete, or recreate.' >&2
	exit 1
	;;
esac

if [[ "$ACTION" != delete ]]; then
	: "${MAPLE_AZURE_OWNER_CIDR:?Set the owner IPv4 address as a /32 CIDR}"
	[[ "$MAPLE_AZURE_OWNER_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]] || {
		echo 'Owner access must be an IPv4 address with a /32 suffix.' >&2
		exit 1
	}
	IFS=. read -r -a owner_octets <<<"${MAPLE_AZURE_OWNER_CIDR%/32}"
	for owner_octet in "${owner_octets[@]}"; do
		((10#$owner_octet <= 255)) || {
			echo 'Invalid owner IPv4 address.' >&2
			exit 1
		}
	done
fi

: "${AZURE_TEST_SUBSCRIPTION_ID:?Azure test subscription is required}"
ACTIVE_SUBSCRIPTION="$(az account show --query id -o tsv)"
[[ "$ACTIVE_SUBSCRIPTION" == "$AZURE_TEST_SUBSCRIPTION_ID" ]] || {
	echo 'Active Azure subscription does not match the configured test subscription.' >&2
	exit 1
}
MANAGED_SERVER="$(az group show --name "$RESOURCE_GROUP" --query 'tags."maple-test-server"' -o tsv)"
[[ "$MANAGED_SERVER" == "$VM_NAME" ]] || {
	echo 'The resource group is not tagged for this test server.' >&2
	exit 1
}

# Check the entire inventory before deleting anything. Refuse unfamiliar
# resources rather than remove infrastructure added to this group by hand.
INVENTORY="$(az resource list --resource-group "$RESOURCE_GROUP" --query '[].[type,name,id]' -o tsv)"
while IFS=$'\t' read -r resource_type resource_name resource_id; do
	[[ -n "$resource_type" ]] || continue
	case "$resource_type:$resource_name" in
	"Microsoft.Compute/virtualMachines:$VM_NAME" | \
		"Microsoft.Compute/disks:${VM_NAME}_OsDisk_1_"* | \
		"Microsoft.Network/networkInterfaces:${VM_NAME}VMNic" | \
		"Microsoft.Network/virtualNetworks:${VM_NAME}VNET" | \
		"Microsoft.Network/networkSecurityGroups:${VM_NAME}-nsg" | \
		"Microsoft.Network/publicIPAddresses:${VM_NAME}-ip") ;;
	*)
		echo "Unexpected resource in test group: $resource_type / $resource_name" >&2
		exit 1
		;;
	esac
done <<<"$INVENTORY"

if [[ "$ACTION" == delete || "$ACTION" == recreate ]]; then
	# VM first, then dependent resources. Include the detached OS disk, which
	# contains SQLite, passkeys, config, and any backups kept on the server.
	for delete_type in \
		Microsoft.Compute/virtualMachines \
		Microsoft.Network/networkInterfaces \
		Microsoft.Compute/disks \
		Microsoft.Network/publicIPAddresses \
		Microsoft.Network/virtualNetworks \
		Microsoft.Network/networkSecurityGroups; do
		while IFS=$'\t' read -r resource_type resource_name resource_id; do
			[[ "$resource_type" == "$delete_type" ]] || continue
			# A VM's delete policy may already have removed a child resource.
			REMAINING="$(az resource list --resource-group "$RESOURCE_GROUP" --query "[?id=='$resource_id'].id" -o tsv)"
			[[ -n "$REMAINING" ]] || continue
			az resource delete --ids "$resource_id"
			az resource wait --deleted --ids "$resource_id" --interval 5 --timeout 900
		done <<<"$INVENTORY"
	done
fi

REMAINING_COUNT="$(az resource list --resource-group "$RESOURCE_GROUP" --query 'length(@)' -o tsv)"
[[ "$REMAINING_COUNT" == 0 ]] || {
	echo 'The test server still exists. Choose Recreate to reset it, or Delete to remove it.' >&2
	exit 1
}

if [[ "$ACTION" != delete ]]; then
	export MAPLE_AZURE_RESOURCE_GROUP="$RESOURCE_GROUP"
	export MAPLE_AZURE_VM_NAME="$VM_NAME"
	export MAPLE_AZURE_DNS_LABEL="$VM_NAME"
	export MAPLE_AZURE_REGION=eastus
	# The workflow removes the runner's SSH rule even if provisioning fails.
	if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
		printf 'provisioning_started=true\n' >>"$GITHUB_OUTPUT"
	fi
	bash "$ROOT/scripts/provision-apple-test-server-azure.sh"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
	{
		printf '## Azure test server: %s\n\n' "$ACTION"
		printf 'Resource group: %s (retained for scoped Azure permissions).\n\n' "$RESOURCE_GROUP"
		if [[ "$ACTION" == delete ]]; then
			printf 'The VM, disk, network resources, database, and accounts were deleted.\n'
		else
			printf 'URL: https://%s.eastus.cloudapp.azure.com\n\n' "$VM_NAME"
			printf 'Claim the fresh server with a passkey from %s, then create member invite codes in Settings → Users.\n' "$MAPLE_AZURE_OWNER_CIDR"
		fi
	} >>"$GITHUB_STEP_SUMMARY"
fi
