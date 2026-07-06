# Lakehouse Blueprint (§19.5)

Declarative per-factory deployment: fill `factory-params.env`, point kustomize
at this overlay, deploy. The instance self-registers with the group tower — its
reporter's first `POST /federation-ingest/report` creates the `tower.lakehouse`
row, so no manual registration step exists.

```
kustomize build deploy/blueprint | kubectl apply -f -
```

Roles (§22.2):
- **factory** — set `INSIGHT_ROLE=factory` and `CP_FEDERATION_TOWER_ENDPOINT`
  to the HQ ingest URL. No Federation UI/routes exist on this instance.
- **hybrid** (HQ) — set `INSIGHT_ROLE=hybrid`. The tower routes + Federation UI
  mount; optionally point `CP_FEDERATION_TOWER_ENDPOINT` at the instance's own
  loopback so its local site appears in the tower too.

`CP_FEDERATION_SHARED_TOKEN` must match between every factory and the HQ —
it gates the machine ingest surface.
