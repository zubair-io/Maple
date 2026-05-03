# Upgrade note: passkey authentication

`/api/*` is now gated. On first launch after this upgrade, sign in with the
Maple app to claim the server. Existing self-hosted deployments keep their
data — only the access path changes. Set `MAPLE_RP_ID` and `MAPLE_ORIGIN` env
vars to the public hostname of your deployment (defaults: `localhost` /
`http://localhost:3000`).
