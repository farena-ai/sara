# Sara on Kubernetes

For people who already run a cluster. Everyone else: the [install script or Docker Compose](INSTALL.md)
is simpler. The chart is in `deploy/helm/sara` and uses the published image
`ghcr.io/farena-ai/sara`.

## One replica only

Sara is **single-replica**. Her data (a SQLite database, the encrypted vault, uploads, add-ons) lives
on one volume that one process owns. Two pods on the same volume would corrupt it, and two pods with
separate volumes would be two different Saras. So the chart:

- always sets `replicas: 1` (there is no value to change it, and no autoscaler);
- uses the `Recreate` strategy, so an upgrade stops the old pod before the new one starts;
- asks for a `ReadWriteOnce` volume (10 GiB by default), kept when the release is uninstalled.

Do not put her behind a second replica, a HorizontalPodAutoscaler or a `ReadWriteMany` share.
Expect a short break during upgrades.

## Install

```bash
helm install sara ./deploy/helm/sara -n sara --create-namespace
kubectl logs -n sara deploy/sara | grep -i token      # the owner token, printed once
kubectl port-forward -n sara svc/sara 7860:7860       # then open http://127.0.0.1:7860
```

With an ingress and TLS (the chart then sets `SARA_TRUST_PROXY=1` and `SARA_SECURE_COOKIES=1`):

```bash
helm install sara ./deploy/helm/sara -n sara --create-namespace \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set ingress.host=sara.example.com \
  --set ingress.tls.enabled=true --set ingress.tls.secretName=sara-tls
```

Replies stream for minutes: raise the ingress read timeout and turn off response buffering (see the
annotations in `values.yaml`).

## Settings worth knowing

| Value | Default | What it does |
|---|---|---|
| `image.tag` | the chart's `appVersion` | Pin a version (or `X.Y.Z@sha256:…`). |
| `dataDir` | `/var/lib/sara` | Where the volume is mounted; passed as `SARA_DATA`. |
| `persistence.existingClaim` | empty | Use your own claim instead of making one. |
| `persistence.size` / `storageClass` | `10Gi` / cluster default | Size and class of the claim. |
| `existingSecret` | empty | A Secret you made, loaded as environment variables (`envFrom`). |
| `env` | `[]` | Extra plain environment variables. |
| `resources` | 250m CPU, 512 MiB requested; 2 GiB limit | Local models need far more; run them elsewhere (Ollama) and point Settings at them. |

Never put provider keys in values or Secrets for her: enter them in Sara, which keeps them in her
encrypted vault on the volume. A Secret is for server settings such as `SARA_BUSINESS_ORIGIN`.

## Security

The pod runs as user 1000 (non-root), with a read-only root filesystem, no privilege escalation, all
capabilities dropped, the default seccomp profile and no service-account token. `/tmp` is an
in-memory scratch folder; the volume is the only place she keeps anything.

### Tool isolation

Run as an ordinary user, her shell commands and MCP servers run as that same user and could read her
data. The image's stronger mode starts as root only to run them as a separate `sara-tools` user that
can't read her keys (as `docker-compose.yml` does). If you allow her tools and want that, override:

```yaml
podSecurityContext:
  runAsNonRoot: false
  runAsUser: 0
  fsGroup: 0
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]
    add: [SETUID, SETGID, CHOWN, FOWNER, DAC_OVERRIDE, KILL]
```

Clusters that enforce the *restricted* Pod Security Standard refuse that; keep the default there.

## Health and backups

Liveness and readiness probes call `/api/health` on port 7860. For a business profile
(`SARA_PROFILE=business`), the health check needs the business origin's host; use the image's own
`HEALTHCHECK` logic or point the probes at a TCP check.

Back up the volume (her memories, vault and settings) with your cluster's snapshot tool, or use
Sara's own backups (Settings → Data & health). Restoring means: scale to zero, restore the volume,
start again.
