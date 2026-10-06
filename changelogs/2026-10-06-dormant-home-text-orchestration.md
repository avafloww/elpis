# Added dormant scoped home-text orchestration

A new one-shot orchestration module joins the existing isolated provider and exact Discord delivery executors without exposing route or branch selectors. It can derive only the invocation held by the active root coordinator and immutable home-text scope.

Recovery now records provider disposition before speech disposition and before generic branch recovery. One recovery timestamp is reused across those steps, and branch recovery rejects a timestamp earlier than any durable attempt, response, outcome, effect, speech barrier, or receipt. A provider success that existed before the current orchestration call is never turned into a delayed Discord send.

The module is not wired into Agent or startup routing, does not activate the context graph, and adds no network authority. Fresh post-activation ingress remains unsupported until a later durable active-mode admission and assembly seam is implemented.
