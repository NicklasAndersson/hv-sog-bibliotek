export type Env = {
    [K in `BUCKET_${string}`]: R2Bucket;
} & {
    AUTH_USERNAME: string;
    AUTH_PASSWORD: string;
};

export interface SiteConfig {
    name: string;
    bucket: R2Bucket;
    desp: {
        [path: string]: string;
    };
    decodeURI?: boolean;
    legalInfo?: string;
    showPoweredBy?: boolean;
    favicon?: string;
    dangerousOverwriteZeroByteObject?: boolean;
    /**
     * Optional redirect function. Called with the bucket and requested object key (the path without leading '/').
     * Return an object with a target key and a `force` boolean.
     * - key: the target key to which the request should be redirected
     * - force: when true, perform the redirect even if the original key exists as an object in the bucket
     * When not provided, no redirect is performed.
     */
    redirect?: (bucket: R2Bucket, key: string) => Promise<{ key: string; force: boolean }>;
    /**
     * Optional sortFn: Custom sorting function for files and folders.
     * It is expected to return a negative value if the first argument
     * is less than the second argument, zero if they're equal,
     * and a positive value otherwise. If omitted, the elements are
     * displayed in the order returned by R2.
     */
    sortFn?: {
        files?: (a: R2Object, b: R2Object) => number;
        folders?: (a: string, b: string) => number;
    };
}
