import type { WorkspaceContext } from './types.ts';
import type { BusinessWorkspaces, WorkspaceReader, WorkspaceSearchHit } from './workspaces.ts';

/** Awaited retrieval can only receive a scoped reader; no personal app/settings/provider argument. */
export class BusinessRetrieval {
  readonly #workspaces: BusinessWorkspaces;
  constructor(workspaces: BusinessWorkspaces) { this.#workspaces = workspaces; }
  async retrieve<T>(context: WorkspaceContext, operation: (scope: WorkspaceReader) => Promise<T>): Promise<T> {
    const reader = this.#workspaces.openWorkspace(context);
    const result = await operation(reader);
    this.#workspaces.revalidate(context); return result;
  }
  async modelContext(context: WorkspaceContext, query: string): Promise<BusinessModelContext> {
    return this.retrieve(context, async scope => {
      const hits = await scope.search(query);
      return Object.freeze({ profile: 'business' as const, workspaceId: context.workspaceId, policyRevision: context.policyRevision, hits: Object.freeze(hits.map(hit => Object.freeze(hit))) });
    });
  }
}

export interface BusinessModelContext {
  readonly profile: 'business';
  readonly workspaceId: string;
  readonly policyRevision: number;
  readonly hits: readonly Readonly<WorkspaceSearchHit>[];
}
