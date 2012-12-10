var set = Ember.set;

// This code initializes the IndexedDB database and defers Ember
// readiness until it gets a reference to an IDBDatabase.
Ember.onLoad('application', function(app) {
  app.deferReadiness();

  var indexedDB = window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB || window.msIndexedDB;

  // We are not setting a default indexedDB database name, 
  // since it may conflict with other apps running on the same host.
  // Such could be the case when the app runs from the local filesystem.
  // TODO: it should check for conflicts with other apps on the same host, checking for extistence of db, ...
  var dbName = app.databaseName;
  Ember.assert('The indexedDB database name (databaseName) is not set in your Application object root', dbName);

  var createSchema = function(db) {
    var dbStore = db.createObjectStore(dbName, { keyPath: 'id' });
    dbStore.createIndex("_type", "_type", { unique: false })
  };

  var oldUpgradeNeededCheck = function(db, callback) {
    if (parseInt(db.version, 10) !== 1) {
      var setVersion = db.setVersion('1');
      setVersion.addEventListener('success', function() {
        createSchema(db);

        // Don't indicate readiness if still inside of the
        // "setVersion transaction". This craziness is
        // removed from the upgradeneeded version of the API.
        //
        // This returns the thread of execution to the
        // browser, thus ending the transaction.
        setTimeout(function() {
          callback(null, db);
        }, 1);
      });
    } else {
      callback(null, db);
    }
  };

  var openDB = function(name, callback) {
    var request = indexedDB.open(name, 1);

    // In the newer version of the API, if the version of the
    // schema passed to `open()` is newer than the current
    // version of the schema, this event is triggered before
    // the browser triggers the `success` event..
    request.addEventListener('upgradeneeded', function(event) {
      createSchema(request.result);
    });

    request.addEventListener('error', function(event) {
      // Node-style "error-first" callbacks.
      callback(event);
    });

    request.addEventListener('success', function(event) {
      var db = request.result;

      // Chrome (hopefully "Old Chrome" soon)
      if ('setVersion' in db) {
        oldUpgradeNeededCheck(db, callback);
      } else {
        // In the sane version of the spec, the success event
        // is only triggered once the schema is up-to-date
        // for the current version.
        callback(null, db);
      }
    });
  };

  openDB(dbName, function(error, db) {
    if (error) {
      // TODO: There is some kind of API that seems to require conversion from
      // a numeric error code to a human code.
      throw new Error("The ember-records database could not be opened for some reason.");
    }

    set(app, 'router.store.adapter.db', db);
    set(app, 'router.store.adapter.dbName', dbName);

    app.advanceReadiness();
  });
});