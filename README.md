Ember Data IndexedDB adapter
=================================================

Based on [https://github.com/wycats/indexeddb-experiment]https://github.com/wycats/indexeddb-experiment. 


Usage
=====

1. Include `ember-data-indexeddb-adapter.js` in your ember/ember-data app.

2. Set the `databaseName` in your app definition:

```js
App = Ember.Application.extend({
  databaseName: 'contacts-app-database'
});

```

Todo
----

- Tests

- Set the database name automatically, avoiding conflicts.