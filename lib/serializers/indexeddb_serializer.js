var get = Ember.get, set = Ember.set;

DS.IndexedDBSerializer = DS.JSONSerializer.create({
  addBelongsTo: function(hash, record, key, relationship) {
    hash[relationship.key] = get(get(record, key), 'id');
  },

  addHasMany: function(hash, record, key, relationship) {
    var ids = get(record, key).map(function(child) {
      return get(child, 'id');
    });

    hash[relationship.key] = ids;
  },

  addId: function(hash, type, id) {
    hash.id = [type.toString(), id];
  },

  extractId: function(type, hash) {
    // newly created records should not try to materialize
    if (hash && hash.id) { return hash.id[1]; }
  },

  toJSON: function(record, options) {
    options = options || {};

    var hash = {}, id;

    if (options.includeId) {
      if (id = get(record, 'id')) {
        this.addId(hash, record.constructor, id);
      }
    }

    this.addAttributes(hash, record);

    this.addRelationships(hash, record);

    return hash;
  }
});