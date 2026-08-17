# Kubernetes restricted runtime

The native restricted deployment uses one namespace per agent. The complete target architecture has three Deployments in that namespace:

1. `elpis-harness`: the inhabitant, with no Kubernetes token or provider credential.
2. an HTTPS egress proxy: the only internet path and the only holder of provider credentials.
3. `elpis-restart-broker`: a narrow lifecycle controller that can recreate the fixed-label harness Pod without mutating its workload spec.

The proxy is a separate security project. This document covers only the shipped restart broker; it does not claim the egress boundary exists yet.

## Restart broker

Apply `deploy/kubernetes/restart-broker/broker.yaml` in the agent namespace, then merge `harness-patch.yaml` into the harness Deployment. The relevant invariant is:

- the harness has `automountServiceAccountToken: false` and receives only `ELPIS_RESTART_ENDPOINT=http://elpis-restart-broker:8080/v1/restart`; the requester freezes this endpoint at process boot;
- the broker Role has only `list` and `delete` on Pods in this one-agent namespace—no Deployment mutation, workload creation, exec, logs, or Secret access;
- `elpis.restart()` can submit only a bounded reason. The endpoint and Kubernetes credential are operator-configured; target, image, command, volumes, and security context are not request fields;
- the broker requires exactly one Pod with the fixed harness labels, verifies that its controller is an `elpis-harness-*` ReplicaSet, and deletes that exact Pod with a UID precondition;
- the Deployment/ReplicaSet controller recreates the Pod from its unchanged operator-owned template. `imagePullPolicy: Always` refreshes the template's configured image tag.

The broker deliberately has no registry client and needs no public egress. Kubelet resolves and pulls the configured image when it starts the replacement. The restart has ordinary single-replica interruption, but there is no scale-to-zero state in which a broker crash can strand the agent offline.

Kubernetes RBAC cannot constrain `list` or `delete` by label. If the broker token were fully compromised, it could delete other Pods in the same one-agent namespace and cause denial of service. It still cannot create code, alter an image or command, exec into a container, or read Secrets. Keeping one agent per namespace contains that residual destructive authority.

The restricted inhabitant intentionally already has code execution inside its own existing container through the sandbox shell and trusted extensions. This design does not remove that faculty; it prevents the restart channel from turning it into a different image, workload specification, broker execution, or cluster-level code execution.

If the namespace uses default-deny egress, the broker still needs TCP access to the Kubernetes API Service. `broker-egress-k3s.yaml` contains the default k3s `10.43.0.1/32`; verify `kubectl get service kubernetes -o jsonpath='{.spec.clusterIP}'` and change the CIDR before applying it.

The broker runs from the normal Elpis image with an overridden command:

```text
node /opt/elpis/dist/k8s/restart-broker.js
```

`NODE_EXTRA_CA_CERTS` points Node at the projected service-account CA. The broker never logs the request reason or token and returns only coarse failure text to the harness.

## Per-agent namespace

Keep the Role, Secrets, NetworkPolicies, ResourceQuota, PVC, harness, proxy, and broker inside one namespace. Use a namespaced Role/RoleBinding, never a ClusterRole. The broker Role must remain Pod `list`+`delete` only. Namespace deletion is then the complete teardown boundary.

The final proxy deployment should enforce default-deny ingress and egress, deny harness DNS/direct internet, mount the provider Secret only into the proxy, strip caller-supplied auth, inject credentials only for exact allowed destinations, mount only the proxy CA certificate into the harness, and set `NO_PROXY=elpis-restart-broker` so the internal lifecycle request never traverses the MITM proxy. Until that proxy is implemented and accepted, do not describe this broker-only manifest as a complete egress sandbox.
