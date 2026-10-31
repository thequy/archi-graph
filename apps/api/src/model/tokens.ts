// DI tokens for the model module. Kept in a standalone file so both the module
// and the controller can import the token without forming an import cycle
// (module -> controller -> module).

/** Provider token for the Drizzle Db instance (produced by getDb()). */
export const DB_TOKEN = 'ARCHI_GRAPH_DB';
