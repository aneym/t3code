# Queue holds

**Stop** holds the queue, and the hold survives a server restart. **Resume** or a new message
from a client releases it. Older holds without a recorded reason need **Resume** or a cancel. A
restart releases only the holds it set itself.

Messages sent from the CLI or MCP join the queue by default. They steer, interrupt or restart
only when the sender asks, and none of those clear a hold. `thread resume` and `t3_queue_resume`
release a hold; `thread unqueue` cancels a queued message.

With **Settings → Chat → Send queued messages together** on (the default), every queued message
starts as one turn when the agent finishes, in queue order and labeled with its sender. A
completed turn also releases held messages; after **Stop** they stay held until you resume. Turn
the setting off to start queued messages one turn at a time.
