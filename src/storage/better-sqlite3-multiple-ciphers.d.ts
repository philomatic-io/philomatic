/** The `-multiple-ciphers` build is API-identical to better-sqlite3, but its package
 *  `exports` map hides its bundled typings from our resolver — so it borrows the stock
 *  driver's declarations, which describe the same surface. */
declare module 'better-sqlite3-multiple-ciphers' {
  import Database = require('better-sqlite3');
  export = Database;
}
