'use strict';
/**
 * Who may see / change which rows.
 *   scope = { ownerId }   one owner's rows
 *   scope = { ownerId: null } all rows (admins only, ?owner=all)
 *   scope = { ownerId: null, createdBy } rows an admin created for anyone (?owner=created);
 *           only entries and proxies record a creator – other lists show all rows for it
 */
const { isId } = require('../lib/ids');
const { E } = require('../lib/errors');

/** ?owner= -> scope. Users get their own rows; asking for anyone else is forbidden. */
function scopeFor(actor, owner) {
    if (owner === undefined || owner === null || owner === '' || owner === actor.id) return { ownerId: actor.id };
    if (actor.role !== 'admin') throw E.forbidden('You can only see your own data.');
    if (owner === 'all') return { ownerId: null };
    if (owner === 'created') return { ownerId: null, createdBy: actor.id };
    if (!isId(owner)) throw E.badRequest('owner must be a user id, "all" or "created"');
    return { ownerId: owner };
}

/** SQL fragment + params for a scope on table alias `a`. */
function scopeSql(scope, alias = 't') {
    return scope.ownerId ? { where: `${alias}.owner_id = ?`, params: [scope.ownerId] } : { where: '1 = 1', params: [] };
}

/** Extra WHERE for ?owner=created on tables with a created_by column. */
function createdSql(scope, alias) {
    return scope.createdBy ? { where: ` AND ${alias}.created_by = ?`, params: [scope.createdBy] } : { where: '', params: [] };
}

/** New owner on update: unchanged, or (admins only) another existing user. -> owner id or null (= unchanged). */
function ownerForUpdate(actor, row, ownerId, users) {
    if (ownerId === undefined || ownerId === null || ownerId === '' || ownerId === row.owner_id) return null;
    if (actor.role !== 'admin') throw E.forbidden('Only an admin can give an item to another user.');
    if (!users.get(ownerId)) throw E.validation({ ownerId: 'Unknown user.' });
    return ownerId;
}

/** The row may be changed by its owner or any admin. Others get 404 (no existence leak). */
function assertCanTouch(actor, row, what = 'Item') {
    if (!row || (row.owner_id !== actor.id && actor.role !== 'admin')) throw E.notFound(`${what} not found.`);
}

/** Owner for a new row: the caller, or (admins only) body.ownerId. */
function ownerForCreate(actor, ownerId, users) {
    if (ownerId === undefined || ownerId === null || ownerId === '' || ownerId === actor.id) return actor.id;
    if (actor.role !== 'admin') throw E.forbidden('You can only create your own data.');
    if (!users.get(ownerId)) throw E.validation({ ownerId: 'Unknown user.' });
    return ownerId;
}

module.exports = { scopeFor, scopeSql, createdSql, assertCanTouch, ownerForCreate, ownerForUpdate };
