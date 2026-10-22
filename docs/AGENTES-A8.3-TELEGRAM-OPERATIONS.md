# A.8.3 — Telegram commercial operations

## Capability and authorization

Telegram sales and purchases are disabled unless both the assistant webhook and `TELEGRAM_ASSISTANT_OPERATIONS_ENABLED=true` are explicitly configured. The configuration rejects enabling operations while the assistant is disabled. No production flag was changed by this port.

Only an active, bound `admin` may confirm or cancel a Telegram commercial preview. The backend reloads the bound user before processing a confirmation and the assistant adapter checks active status, business identity, and admin role before calling the shared action gateway. A normal `user` cannot execute a write. Role and tenant values from messages, callback data, and preview contents are never treated as authority.

## Write path

Requests use the existing Operations resolvers and `PendingAction` gateway. Text can prepare a preview but cannot execute it. The preview must contain the gateway's authoritative product, quantity, price, subtotal, stock, supplier/customer, currency, and total fields before Confirm/Cancel buttons are issued. Opaque one-use callback tokens bind the action ID to the Telegram binding, conversation, keyboard message, and expiry. Callback inputs do not carry commercial arguments.

Confirmation reuses `confirmPendingAction`; cancellation reuses `cancelPendingAction`. The action gateway retains its transaction, validation, audit, and idempotency behavior. Receipts and history are reconciled against the gateway after an uncertain result; a possibly executed write is never retried. Web Assistant continues to use its existing default `assistant` channel and confirmation flow.

## Indexes and local integration

No additional index is required for `pendingActionId` or the new callback purposes: callback admission queries the existing unique token and binding indexes, while action status is read through the existing scoped `PendingAction` gateway/indexes. The established administrative index provisioning procedure is unchanged and must not be run against Atlas as part of development.

The integration suite accepts only a local, isolated MongoDB database with replica set `rs0`; it refuses cloud hosts and refuses a non-empty database. It creates a random disposable database and drops only that database after successful setup. Telegram API and FX calls are mocked.

Do not enable the production assistant or Operations during development or deployment. This document records the code path and tests; it is not authorization to provision indexes, configure a webhook, or enable the channel.
