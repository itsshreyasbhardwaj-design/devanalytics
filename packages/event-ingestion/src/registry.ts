import type { Provider, ProviderRegistry, RepositorySource, WebhookAdapter } from '@devanalytics/core';

/**
 * Provider registry.
 *
 * Adding GitLab, CircleCI or Jenkins means registering an adapter here. No
 * other part of the system names a provider.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  private readonly webhooks = new Map<string, WebhookAdapter>();
  private readonly sources = new Map<string, RepositorySource>();

  registerWebhook(adapter: WebhookAdapter): this {
    this.webhooks.set(adapter.provider, adapter);
    return this;
  }

  registerSource(source: RepositorySource): this {
    this.sources.set(source.provider, source);
    return this;
  }

  webhook(provider: string): WebhookAdapter | null {
    return this.webhooks.get(provider) ?? null;
  }

  source(provider: string): RepositorySource | null {
    return this.sources.get(provider) ?? null;
  }

  list(): Provider[] {
    return [...new Set([...this.webhooks.keys(), ...this.sources.keys()])] as Provider[];
  }

  get adapterMap(): Map<string, WebhookAdapter> {
    return this.webhooks;
  }
}
