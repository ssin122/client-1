'use strict';

var angular = require('angular');

var events = require('./events');
var retryUtil = require('./retry-util');

var CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function sessionActions(options) {
  var actions = {
    login: {
      method: 'POST',
      params: { __formid__: 'login' },
    },

    logout: {
      method: 'POST',
      params: { __formid__: 'logout' },
    },

    _load: { method: 'GET' },
  };

  Object.keys(actions).forEach(function (action) {
    Object.assign(actions[action], options);
  });

  return actions;
}


/**
 * @ngdoc service
 * @name session
 * @description
 * Access to the application session and account actions. This service gives
 * other parts of the application access to parts of the server-side session
 * state (such as current authenticated userid, CSRF token, etc.).
 *
 * In addition, this service also provides helper methods for mutating the
 * session state, by, e.g. logging in, logging out, etc.
 *
 * @ngInject
 */
function session($http, $resource, $rootScope, annotationUI, auth,
                 flash, raven, settings, store) {
  // Headers sent by every request made by the session service.
  var headers = {};
  var actions = sessionActions({
    headers: headers,
    transformResponse: process,
    withCredentials: true,
  });
  var endpoint = new URL('app/:path', settings.serviceUrl).href;
  var resource = $resource(endpoint, {}, actions);

  // Cache the result of _load()
  var lastLoad;
  var lastLoadTime;


  // Return the authority from the first service defined in the settings.
  // Return null if there are no services defined in the settings.
  function getAuthority() {
    if (Array.isArray(settings.services) && settings.services.length > 0) {
      return settings.services[0].authority;
    }
    return null;
  }

  /**
   * @name session.load()
   * @description Fetches the session data from the server.
   * @returns A promise for the session data.
   *
   * The data is cached for CACHE_TTL across all actions of the session
   * service: that is, a call to login() will update the session data and a call
   * within CACHE_TTL milliseconds to load() will return that data rather than
   * triggering a new request.
   */
  resource.load = function () {
    if (!lastLoadTime || (Date.now() - lastLoadTime) > CACHE_TTL) {

      // The load attempt is automatically retried with a backoff.
      //
      // This serves to make loading the app in the extension cope better with
      // flakey connectivity but it also throttles the frequency of calls to
      // the /app endpoint.
      lastLoadTime = Date.now();
      lastLoad = retryUtil.retryPromiseOperation(function () {
        var authority = getAuthority();
        if (authority) {
          return store.profile.read({authority: authority}).then(update);
        } else {
          return resource._load().$promise;
        }
      }).then(function (session) {
        lastLoadTime = Date.now();
        return session;
      }).catch(function (err) {
        lastLoadTime = null;
        throw err;
      });
    }
    return lastLoad;
  };

  /**
   * @name session.dismissSidebarTutorial()
   *
   * @description Stores the preference server-side that the user dismissed
   *              the sidebar tutorial, and then updates the session state.
   */
  function dismissSidebarTutorial() {
    return store.profile.update({}, {preferences: {show_sidebar_tutorial: false}}).then(update);
  }

  /**
   * @name session.update()
   *
   * @description Update the session state using the provided data.
   *              This is a counterpart to load(). Whereas load() makes
   *              a call to the server and then updates itself from
   *              the response, update() can be used to update the client
   *              when new state has been pushed to it by the server.
   */
  function update(model) {
    var prevSession = annotationUI.getState().session;

    var isInitialLoad = !prevSession.csrf;

    var userChanged = model.userid !== prevSession.userid;
    var groupsChanged = !angular.equals(model.groups, prevSession.groups);

    // Update the session model used by the application
    annotationUI.updateSession(model);

    // Set up subsequent requests to send the CSRF token in the headers.
    if (model.csrf) {
      headers[$http.defaults.xsrfHeaderName] = model.csrf;
    }

    lastLoad = Promise.resolve(model);
    lastLoadTime = Date.now();

    if (userChanged) {
      if (!getAuthority()) {
        auth.clearCache();
      }

      $rootScope.$broadcast(events.USER_CHANGED, {
        initialLoad: isInitialLoad,
        userid: model.userid,
      });

      // associate error reports with the current user in Sentry
      if (model.userid) {
        raven.setUserInfo({
          id: model.userid,
        });
      } else {
        raven.setUserInfo(undefined);
      }
    }

    if (groupsChanged) {
      $rootScope.$broadcast(events.GROUPS_CHANGED, {
        initialLoad: isInitialLoad,
      });
    }

    // Return the model
    return model;
  }

  function process(data, headersGetter, status) {
    if (status < 200 || status >= 500) {
      return null;
    }

    data = angular.fromJson(data);

    // Lift response data
    var model = data.model || {};
    if (typeof data.errors !== 'undefined') {
      model.errors = data.errors;
    }
    if (typeof data.reason !== 'undefined') {
      model.reason = data.reason;
    }

    // Fire flash messages.
    for (var type in data.flash) {
      if (data.flash.hasOwnProperty(type)) {
        var msgs = data.flash[type];
        for (var i = 0, len = msgs.length; i < len; i++) {
          flash[type](msgs[i]);
        }
      }
    }

    return update(model);
  }

  function logout() {
    return resource.logout().$promise.then(function () {
      auth.clearCache();
    }).catch(function (err) {
      flash.error('Log out failed');
      throw err;
    });
  }

  return {
    dismissSidebarTutorial: dismissSidebarTutorial,
    load: resource.load,
    login: resource.login,
    logout: logout,

    // For the moment, we continue to expose the session state as a property on
    // this service. In future, other services which access the session state
    // will do so directly from annotationUI or via selector functions
    get state() {
      return annotationUI.getState().session;
    },

    update: update,
  };
}

module.exports = session;
