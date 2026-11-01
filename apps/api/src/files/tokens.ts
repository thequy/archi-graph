// DI tokens for the files module. Kept in a standalone, cycle-free file so the
// module, service, and controller can import a token without forming an import
// cycle (module -> controller -> module).

/** Provider token for the filesystem blob store (produced by createStorage()). */
export const STORAGE_TOKEN = 'ARCHI_GRAPH_STORAGE';
