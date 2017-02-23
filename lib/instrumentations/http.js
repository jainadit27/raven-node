'use strict';

var util = require('util');

// todo: move this to a shared instrumentation utils module
function fill(obj, name, replacement, track) {
  var orig = obj[name];
  obj[name] = replacement(orig);
  if (track) {
    track.push([obj, name, orig]);
  }
}

// todo patch through originals collection/restoring
var originals = [];

module.exports = function (Raven, http) {
  var OrigClientRequest = http.ClientRequest;
  var ClientRequest = function (options, cb) {
    // Note: this won't capture a breadcrumb if a response never comes
    // It would be useful to know if that was the case, though, so
    // todo: revisit to see if we can capture sth indicating response never came
    // possibility: capture one breadcrumb for "req sent" and one for "res recvd"
    // seems excessive but solves the problem and *is* strictly more information
    // could be useful for weird response sequencing bug scenarios
    var self = this;
    OrigClientRequest.call(self, options, cb);

    // We could just always grab these from self.agent, self.method, self._headers, self.path, etc
    // but certain other http-instrumenting libraries (like nock, which we use for tests) fail to
    // maintain the guarantee that after calling OrigClientRequest, those fields will be populated
    var url, method;
    if (typeof options === 'string') {
      url = options;
      method = 'GET';
    } else {
      url = (options.protocol || '') + '//' +
            (options.hostname || options.host || '') +
            (options.path || '/');
      method = options.method || 'GET';
    }

    // Don't capture breadcrumb for our own requests
    if (!Raven.dsn || url.indexOf(Raven.dsn.host) === -1) {
      fill(self, 'emit', function (origEmit) {
        return function (evt, maybeResp) {
          if (evt === 'response') {
            Raven.captureBreadcrumb({
              type: 'http',
              category: 'http',
              data: {
                method: method,
                url: url,
                status_code: maybeResp.statusCode
              }
            });
          }
          return origEmit.apply(this, arguments);
        };
      }, originals);
    }
  };
  util.inherits(ClientRequest, OrigClientRequest);
  fill(http, 'ClientRequest', function () {
    return ClientRequest;
  }, originals);

  // http.request orig refs module-internal ClientRequest, not exported one, so
  // it still points at orig ClientRequest after our monkeypatch; these reimpls
  // just get that reference updated to use our new ClientRequest
  fill(http, 'request', function () {
    return function (options, cb) {
      return new http.ClientRequest(options, cb);
    };
  }, originals);

  fill(http, 'get', function () {
    return function (options, cb) {
      var req = http.request(options, cb);
      req.end();
      return req;
    };
  }, originals);
};