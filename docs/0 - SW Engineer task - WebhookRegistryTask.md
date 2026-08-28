# Webhook Registry + Dispatcher

Build a system where users can register webhook URLs for specific event types, 
and the system dispatches events to matching subscribers.
Requirements / constraints:

1. TypeScript (preferred) ~~or Java~~
2. You can use any AI, in such case provide the conversation and/or plan/spec/steering rules.
3. CRUD APIs:
   a. to manage webhook subscriptions (event type, target URL): /subscriptions
   b. to publish events: /events
4. Dispatcher that for each matching subscription delivers the event to the subscriber
5. Data must be persisted to external storage (bonus: DynamoDB)
6. Bonus: Delivery status tracking endpoint(s): /deliveries
7. Bonus: CloudFormation configuration (you don't have to deploy it and we won't deploy it)
8. Bonus: anything that makes it production-ready
9. Should you find any gaps in this spec, fill them yourself.

This task is supposed to take less than 4 hours.

Send solution back in a ZIP archive.