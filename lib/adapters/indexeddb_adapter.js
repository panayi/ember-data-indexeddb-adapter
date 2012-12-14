require('serializers/indexeddb_serializer');

var get = Ember.get, set = Ember.set;


DS.IndexedDBAdapter = DS.Adapter.extend({
  serializer: DS.IndexedDBSerializer,

  /**
    Hook used by the store to generate client-side IDs. This simplifies
    the timing of committed related records, so it's preferable.

    For this adapter, we use uuid.js by Rober Kieffer, which generates
    UUIDs using the best-available random number generator.

    @returns {String} a UUID
  */
  generateIdForRecord: function() {
    return uuid();
  },

  /**
    Takes a (record) or (a modelType and an id)
    and build the serialized id [type, id] to be stored in the db.
  **/
  dbId: function(obj, id) {
    if (obj instanceof DS.Model) {
      return [obj.constructor.toString(), get(obj, 'id')]
    } else {
      return [obj.toString(), id];
    }
  },

  toJSON: function(record, options) {
    return get(this, 'serializer').toJSON(record, options);
  },

  /**
    The main entry point called by Ember Data.

    It receives a store to notify when records have
    successfully saved, and a hash of information about
    what to commit.
  */
  save: function(store, commitDetails) {
    var relationships = commitDetails.relationships;

    relationships.forEach(function(relationship) {
      // HACK If a part of the relationship is
      // unmaterialized, also check to see whether
      // it's in any of the commitDetails.
      //
      // The store in Ember Data should really
      // prevent this from happening by correctly
      // hooking up newly materialized records if
      // they are part of a pending relationship.

      var child = relationship.getChild(),
          oldParent = relationship.getOldParent(),
          newParent = relationship.getNewParent();

      if (child === undefined || !this.any(child, commitDetails)) {
        this.updateChildRelationship(store, relationship);
      }

      if (oldParent === undefined || !this.any(oldParent, commitDetails)) {
        this.updateOldParentRelationship(store, relationship);
      }

      if (newParent === undefined || !this.any(newParent, commitDetails)) {
        this.updateNewParentRelationship(store, relationship);
      }
    }, this);

    return this._super.apply(this, arguments);
  },

  /**
    Main hook for saving a newly created record.

    @param {DS.Store} store
    @param {Class} type
    @param {DS.Model} record
  */
  createRecord: function(store, type, record) {
    var hash = this.toJSON(record, { includeId: true });
    var self = this;

    // Store the type in the value so that we can index it on read
    hash._type = type.toString();
    
    this.attemptDbTransaction(store, record, function(dbStore) {
      self.didSaveRecord(store, record, hash);
      return dbStore.add(hash);
    });
  },

  /**
    Main hook for updating an existing record.

    @param {DS.Store} store
    @param {Class} type
    @param {DS.Model} record
  */
  updateRecord: function(store, type, record) {
    var hash = this.toJSON(record, { includeId: true });
    var self = this;

    // Store the type in the value so that we can index it on read
    hash._type = type.toString();

    this.attemptDbTransaction(store, record, function(dbStore) {
      self.didSaveRecord(store, record, hash);
      return dbStore.put(hash);
    });
  },

  /**
    Main hook for deleting an existing record. Note that
    deletions can also trigger changes in relationships with
    other records.

    If those records are unloaded, those changes happen
    through the update*Relationship family of methods.

    @param {DS.Store} store
    @param {Class} type
    @param {DS.Model} record
  */
  deleteRecord: function(store, type, record) {
    var self = this;
    this.attemptDbTransaction(store, record, function(dbStore) {
      self.didSaveRecord(store, record);
      return dbStore['delete'](self.dbId(record));
    });
  },


  didSaveRecord: function(store, record, hash) {
    record.eachAssociation(function(name, meta) {
      if (meta.kind === 'belongsTo') {
        store.didUpdateRelationship(record, name);
      }
    });
  },

  /**
     The main hook for finding a single record. The `findMany`
     hook defaults to delegating to this method.

     Since the IndexedDB database is local, we don't need to
     implement a specific `findMany` method.

     @param {DS.Store} store
     @param {Class} type
     @param {String|Number} id
  */
  find: function(store, type, id) {
    var dbStore = this.getDbStore(store);
    var dbId = this.dbId(type, id);
    var self = this;

    var request = dbStore.get(dbId);
    request.onerror = function(event) {
      throw new Error("An attempt to read " + type + " with id " + id + " failed");
    };
    request.onsuccess = function(event) {
      var hash = request.result;
      self.didFindRecord(store, type, hash, id);
    };
  },

  didFindRecord: function(store, type, hash, id) {
    if (hash) {
      store.load(type, hash);
    }
  },

  findMany: function(store, type, ids) {
    var cursor, records = [], self = this;

    var isMatchingId = function(hash) {
      return ids.indexOf(cursor.id[1]) !== -1;
    };

    var onSuccess = function(event) {
      if (cursor = event.target.result) {
        if (isMatchingId(cursor.id)) {
          records.pushObject(cursor.value);
        }
        cursor.continue();
      } else {
        self.didFindMany(store, type, records);
      }
    };

    this.read(store, type, onSuccess);
  },

  didFindMany: function(store, type, records) {
    store.loadMany(type, records);
  },

  findAll: function(store, type) {
    var cursor, records = [], self = this;

    var onSuccess = function(event) {
      if (cursor = event.target.result) {
        records.pushObject(cursor.value);
        cursor.continue();
      } else {
        self.didFindAll(store, type, records);
      }
    };

    this.read(store, type, onSuccess);
  },

  didFindAll: function(store, type, records) {
    store.loadMany(type, records);
  },

  /**
   Using a cursor that loops through *all* results, comparing each one against the query. 
   TODO: For performance reasons we should use indexes on query attributes.
   (https://developer.mozilla.org/en-US/docs/IndexedDB/Using_IndexedDB#Using_an_index)

   @param {DS.Store} store
   @param {Class} type
   @param {Object} query
   @param {Array} array
  */
  findQuery: function(store, type, query, array) {
    var match = function(hash, query) {
      result = true;
      for (var key in query) {
        if (query.hasOwnProperty(key)) {
          result = result && (hash[key] === query[key]);
        }
      }
      return result;
    };

    var cursor, records = [], self = this;
    var onSuccess = function(event) {
      if (cursor = event.target.result) {
        if (match(cursor.value, query)) {
          records.pushObject(cursor.value);
        }
        cursor.continue();
      } else {
        self.didFindQuery(store, type, array, records);
      }
    };

    this.read(store, type, onSuccess);
  },

  didFindQuery: function(store, type, array, records) {
    array.load(records);
  },  

  /**
    Main hook for querying the database
  */
  read: function(store, type, onSuccess, onError) {
    var dbStore = this.getDbStore(store);
    var request = this.buildRequest(dbStore, type);

    onError = onError || function(event) {
      Ember.warning("indexedDB adapter error on querying for type " + type);
    };

    request.onsuccess = onSuccess;
    request.onerror = onError;
  },

  /**
    Return the indexedDB store object
  */
  getDbStore: function(store) {
    var db = get(store, 'db'),
    dbName = get(store, 'dbName'),
    dbTransaction = db.transaction([dbName]);

    return dbTransaction.objectStore(dbName);
  },

  buildRequest: function(dbStore, type) {
    // Index on modelType for faster querying
    var index = dbStore.index('_type');
    var IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange;
    var onlyOfType = IDBKeyRange.only(type.toString());

    return request = index.openCursor(onlyOfType);
  },

  /**
    @private

    Execute some code in the context of an IndexedDB
    transaction. Because operations on an IndexedDB
    database are done on a database's store, this
    method creates a new database transaction, extracts
    its `ember-records` object store and passes it to
    the callback.

    @param {Function} callback a function invoked with
      an IndexedDB object store. Its `this` is set to
      this adapter. This callback is expected to return
      an `IDBRequest` object that is the result of making
      a request on the object store.

    @returns {IDBRequest} An IndexedDB request, such as
      a get, put or delete operation.
  */
  withDbTransaction: function(store, callback) {
    var readwrite = (typeof IDBTransaction !== "undefined") ? IDBTransaction.READ_WRITE : 'readwrite';
    var dbStore = this.getDbStore(store);

    return callback.call(this, dbStore);
  },

  /**
    @private

    Attempt to commit a change to a single Ember Data
    record in the context of an IndexedDB transaction.
    This method delegates most of its work to
    `withDbTransaction`.

    It registers a `success` callback on the `IDBRequest`
    returned by `withDbTransaction`, which notifies the
    Ember Data store that the record was successfully
    saved.

    @param {DS.Store} store the store to notify that the
      record was successfully saved to IndexedDB.
    @param {DS.Model} record the record to save. This
      parameter is passed through to the store's
      `didSaveRecord` method if the IndexedDB request
      succeeds.
    @param {Function} callback a function that actually
      makes a request to the IndexedDB database. It is
      invoked with an `IDBObjectStore`, and is expected
      to return an `IDBRequest`.
  */
  attemptDbTransaction: function(store, record, callback) {
    var dbRequest = this.withDbTransaction(store, callback);

    dbRequest.addEventListener('success', function(s) {
      store.didSaveRecord(record);
    });
  },

  /**
    @private

    Returns true if the record in question is in any
    of the buckets in `commitDetails`.

    XXX include this on commitDetails? (i.e. `commitDetails.any(record)`)

    @param {DS.Model} record
    @param {Object} commitDetails a commitDetails hash
      passed to this adapter.

    @returns {Boolean}
  */
  any: function(record, commitDetails) {
    // null can never be in commitDetails, and it
    // doesn't require any special commit handling
    if (record === null) { return true; }

    if (commitDetails.created.has(record)) {
      return true;
    }

    if (commitDetails.updated.has(record)) {
      return true;
    }

    if (commitDetails.deleted.has(record)) {
      return true;
    }
  },

  /**
    @private

    Happens if a record's parent is deleted but the children are
    not yet materialized. In server-backed cases, this would normally
    be handled by the server, but as we are maintaining both sides of
    the relationship via the adapter, we have to manage unloaded records
    as well.

    @param {DS.Store} store
    @param {DS.OneToManyChange} relationship
  */
  updateChildRelationship: function(store, relationship) {
    var child = relationship.getChildTypeAndId(),
        parent = relationship.getNewParentTypeAndId(),
        parentId = parent ? parent[1] : null;

    this.updateUnloadedRelationship(store, child, relationship, function(hash) {
      var key = get(this, 'serializer')._keyForBelongsTo(child[0], relationship.getBelongsToName());
      hash[key] = parentId;
    });
  },

  /**
    @private

    Happens if a record is deleted but its old parent in the
    relationship is unloaded. In relational backends, this would
    take care of itself, because the parent side is just
    computed from an FK that no longer exists. In other
    server-backed cases, an adapter might want to notify the
    server of the change so it can update its parent-side array.

    @param {DS.Store} store
    @param {DS.OneToManyChange} relationship
  */
  updateOldParentRelationship: function(store, relationship) {
    var oldParent = relationship.getOldParentTypeAndId(),
        child = relationship.getChildTypeAndId(),
        childId = child ? child[1] : null;

    this.updateUnloadedRelationship(store, oldParent, relationship, function(hash) {
      var key = get(this, 'serializer')._keyForHasMany(oldParent[0], relationship.getHasManyName());
      var index = Ember.ArrayPolyfills.indexOf.call(hash[key], childId);
      if (index >= 0) { hash[key].splice(index, 1); }
    });
  },

  /**
    @private

    XXX Is this possible? Should it be possible?

    @param {DS.Store} store
    @param {DS.OneToManyChange} relationship
  */
  updateNewParentRelationship: function(store, relationship) {
    var newParent = relationship.getNewParentTypeAndId(),
        child = relationship.getChildTypeAndId(),
        childId = child ? child[1] : null;

    this.updateUnloadedRelationship(store, newParent, relationship, function(hash) {
      var key = get(this, 'serializer')._keyForHasMany(newParent[0], relationship.getHasManyName());
      var index = Ember.ArrayPolyfills.indexOf.call(hash[key], childId);
      if (index === -1) { hash[key].push(childId); }
    });
  },

  /**
    @private

    Used by other update*Relationship methods.

    @param {Array(Class, String)} updating a two-element array
      whose first element is the type of the record being
      updated, and whose second element is the id of the record.
    @param {OneToManyChange} relationship the change record that
      contains the information being updated. This method notifies
      the change record that it is doing some persistence work
      for a record not in the `commitDetails`, and lets it know
      when that work is done.
    @param {Function} callback a callback that is called with
      the current version of record in IndexedDB and with its
      `this` set to this adapter. Any mutations to hash
      performed in the callback will be persisted back to the
      IndexedDB database.
  */
  updateUnloadedRelationship: function(store, updating, relationship, callback) {
    // make sure that we successfully make the change before marking any
    // materialized records that are part of the transaction as clean.
    relationship.wait();

    var updatingDbId = updating.slice(), self = this;
    updatingDbId[0] = updatingDbId[0].toString();

    var lookup = this.withDbTransaction(store, function(dbStore) {
      return dbStore.get(updatingDbId);
    });

    lookup.addEventListener('error', function() {
      throw new Error("An attempt to update " + updatingDbId[0] + " with id " + updatingDbId[1] + " failed");
    });

    var self = this;
    lookup.addEventListener('success', function() {
      var hash = lookup.result;

      if (hash) {
        callback.call(self, hash);

        var put = self.withDbTransaction(store, function(dbStore) {
          return dbStore.put(hash);
        });

        put.addEventListener('error', function() {
        });

        put.addEventListener('success', function() {
          relationship.done();
        });
      } else {
        throw new Error("An attempt to update " + updatingDbId[0] + " with id " + updatingDbId[1] + " failed");
      }
    });
  }
});