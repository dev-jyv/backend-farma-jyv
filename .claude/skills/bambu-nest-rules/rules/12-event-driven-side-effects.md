# 12 — Post-commit side effects run off domain events

Slow or failure-prone side effects (rendering a PDF, sending email/SMS/push, calling a storage or third-party API) do **not** run inside the request transaction. The service commits its DB work, emits a domain event, and returns; a listener does the side effect out of band. This uses `@nestjs/event-emitter` (`EventEmitterModule.forRoot()` in the root module).

## Contract lives in an `events/` file

Name and payload are colocated and typed:

```ts
export const ORDER_PAID_EVENT = 'order.paid';

export interface OrderPaidEvent {
  orderId: string;
  /** language resolved in the request, for the delivery's error messages */
  lang?: string;
}
```

## Emit AFTER the transaction commits

The emitter fires once the DB work is durable — never from inside a `$transaction` callback (rule 08). Pass through the request `lang` so the async work can localize:

```ts
this.events.emit(ORDER_PAID_EVENT, {
  orderId, lang: I18nContext.current()?.lang,
} satisfies OrderPaidEvent);
```

## Listener does the work, isolated per channel

```ts
@Injectable()
export class OrderPaidListener {
  private readonly logger = new Logger(OrderPaidListener.name);
  constructor(private readonly delivery: OrderReceiptDeliveryService) {}

  @OnEvent(ORDER_PAID_EVENT, { async: true, promisify: true })
  async handleOrderPaid(event: OrderPaidEvent): Promise<void> {
    await this.deliver(event, ReceiptChannel.EMAIL);
    if (SMS_RECEIPTS_ENABLED) {
      await this.deliver(event, ReceiptChannel.SMS);
    }
  }

  private async deliver(event: OrderPaidEvent, channel: ReceiptChannel) {
    try {
      const { sentTo } = await this.delivery.send(event.orderId, channel, event.lang);
      this.logger.log(`Receipt for order ${event.orderId} sent via ${channel} to ${sentTo}`);
    } catch (err) {
      this.logger.error(`Failed to send receipt via ${channel}: ${(err as Error).message}`);
    }
  }
}
```

## Rules

1. **Emit after commit, never mid-transaction.** The transaction owns only DB state; external I/O happens after it succeeds.
2. **Name + payload interface live in an `events/<name>.event.ts`** with an exported const event name and a typed payload. Emit with `satisfies <Payload>`.
3. **Pass request context the listener needs** (notably `lang`) in the payload — the request's `I18nContext` is not available in the async listener.
4. **`@OnEvent(NAME, { async: true, promisify: true })`** for async handlers.
5. **Each side-effect channel is isolated in its own `try/catch`.** A failure is logged and swallowed — it must not propagate (the request already returned) nor block sibling channels. Provide a recovery path (e.g. a resend endpoint) instead of failing the original action.
6. **Gate optional channels behind a validated env flag** (rule 03) to avoid noisy calls when disabled.
7. **Register the listener as a provider** in its module; it's a normal `@Injectable()`.

## When NOT to use an event

If the caller must see the result (validation, pricing, the created resource), do it synchronously in the service. Events are for fire-and-forget effects whose failure should not fail the originating request.
