interface SettingsSnapshot {
    status: 'loading' | 'ready' | 'unavailable';
    value?: unknown;
    base?: unknown;
    user?: unknown;
    revision?: number;
    writable: boolean;
}
interface SettingsScope {
    getSnapshot(): SettingsSnapshot;
    subscribe(listener: () => void): () => void;
    mutate(ops: readonly SettingsOp[], expectedRevision?: number): Promise<boolean>;
}
interface SettingsOp {
    op: 'set' | 'unset';
    path: string[];
    value?: string;
}
interface ClientContext {
    configForms: {
        get<T>(entryId: string): T;
    };
    slots: {
        inject(name: string, register: () => unknown): void;
        register(options: object, component: unknown): () => void;
    };
    effect(install: () => () => void, label: string): void;
}
export declare function DecisionSettingsCard({ scope }: {
    scope: SettingsScope;
}): import("react/jsx-runtime").JSX.Element | null;
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map