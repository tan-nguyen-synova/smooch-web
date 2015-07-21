/* global global:false */
'use strict';
require('./bootstrap');

var Marionette = require('backbone.marionette'),
    Backbone = require('backbone'),
    _ = require('underscore'),
    $ = require('jquery'),
    cookie = require('cookie'),
    uuid = require('uuid'),
    urljoin = require('url-join'),
    bindAll = require('lodash.bindall');

var BaseCollection = require('./collections/baseCollection'),
    /*jshint -W079 */
    Event = require('./models/event'),
    /*jshint +W079 */
    Rule = require('./models/rule'),
    AppUser = require('./models/appUser'),
    ChatController = require('./controllers/chatController'),
    Conversations = require('./collections/conversations'),
    endpoint = require('./endpoint');

var SK_STORAGE = 'sk_deviceid';

// appends the compile stylesheet to the HEAD
require('../stylesheets/main.less');

/**
 * Contains all SupportKit API classes and functions.
 * @name SupportKit
 * @namespace
 *
 * Contains all SupportKit API classes and functions.
 */
var SupportKit = Marionette.Object.extend({
    VERSION: '0.2.12',

    defaultText: {
        headerText: 'How can we help?',
        inputPlaceholder: 'Type a message...',
        sendButtonText: 'Send',
        introText: 'This is the beginning of your conversation.<br/> Ask us anything!'
    },

    initialize: function() {
        bindAll(this);

        this._conversations = new Conversations();
    },

    _checkReady: function(message) {
        if (!this.ready) {
            throw new Error(message || 'Can\'t use this function until the SDK is ready.');
        }
    },

    _updateUser: function() {
        return this.user.save();
    },

    init: function(options) {
        if (this.ready) {
            return;
        }

        // TODO: alternatively load fallback CSS that doesn't use
        // unsupported things like transforms
        if (!$.support.cssProperty('transform')) {
            console.error('SupportKit is not supported on this browser. ' +
                'Missing capability: css-transform');
            return;
        }

        this.ready = false;
        options = options || {};

        if (typeof options === 'object') {
            endpoint.appToken = options.appToken;
            endpoint.jwt = options.jwt;
        } else if (typeof options === 'string') {
            endpoint.appToken = options;
        } else {
            throw new Error('init method accepts an object or string');
        }

        if (!endpoint.appToken) {
            throw new Error('init method requires an appToken');
        }

        var uiText = _.extend({}, this.defaultText, options.customText);


        this.deviceId = this.getDeviceId(options);

        endpoint.post('/api/appboot', {
            deviceId: this.deviceId,
            userId: options.userId,
            deviceInfo: {
                URL: document.location.host,
                userAgent: navigator.userAgent,
                referrer: document.referrer,
                browserLanguage: navigator.language,
                currentUrl: document.location.href,
                sdkVersion: this.VERSION,
                currentTitle: document.title
            }
        })
            .then(_(function(res) {
                this.user = new AppUser({
                    id: res.appUserId
                });

                var EventCollection = BaseCollection.extend({
                    url: urljoin('appusers', res.appUserId, 'event'),
                    model: Event
                });

                var RuleCollection = Backbone.Collection.extend({
                    model: Rule
                });

                // this._events overrides some internals for event bindings in Backbone
                this._eventCollection = new EventCollection(res.events, {
                    parse: true
                });


                // for consistency, this will use the collection suffix too.
                this._ruleCollection = new RuleCollection(res.rules, {
                    parse: true
                });

                endpoint.appUserId = res.appUserId;

                // if the email was passed at init, it can't be changed through the web widget UI
                var readOnlyEmail = !_.isEmpty(options.email);

                this._chatController = new ChatController({
                    collection: this._conversations,
                    user: this.user,
                    readOnlyEmail: readOnlyEmail,
                    uiText: uiText
                });

                return this.updateUser(_.pick(options, 'givenName', 'surname', 'email', 'properties'));
            }).bind(this))
            .then(_(function() {
                this._renderWidget();
            }).bind(this))
            .fail(function(err) {
                var message = err && (err.message || err.statusText);
                console.error('SupportKit init error: ', message);
            })
            .done();
    },

    logout: function() {
        this.destroy();
    },

    getDeviceId: function(options) {
        var userId = options.userId, deviceId;

        // get device ID first from local storage, then cookie. Otherwise generate new one
        deviceId = userId && localStorage.getItem(SK_STORAGE + '_' + userId) ||
            cookie.parse(document.cookie)[SK_STORAGE] ||
            uuid.v4().replace(/-/g, '');

        // reset the cookie and local storage
        document.cookie = SK_STORAGE + '=' + deviceId;
        userId && localStorage.setItem(SK_STORAGE + '_' + userId, deviceId);

        return deviceId;
    },

    resetUnread: function() {
        this._checkReady();
        this._chatController.resetUnread();
    },

    sendMessage: function(text) {
        this._checkReady('Can not send messages until init has completed');
        this._chatController.sendMessage(text);
    },

    open: function() {
        this._checkReady();
        this._chatController.open();
    },

    close: function() {
        this._checkReady();
        this._chatController.close();
    },

    updateUser: function(userInfo) {
        var userChanged = false;

        if (typeof userInfo !== 'object') {
            throw new Error('updateUser accepts an object as parameter');
        }

        userInfo.id = this.user.id;

        userChanged = userChanged || (userInfo.givenName && this.user.get('givenName') !== userInfo.givenName);
        userChanged = userChanged || (userInfo.surname && this.user.get('surname') !== userInfo.surname);
        userChanged = userChanged || (userInfo.email && this.user.get('email') !== userInfo.email);

        if (!userChanged && userInfo.properties) {
            var props = this.user.get('properties');
            _.each(userInfo.properties, function(value, key) {
                userChanged = userChanged || value !== props[key];
            });
        }

        if (!userChanged) {
            return $.Deferred().resolve();
        }

        this.user.set(userInfo, {
            parse: true
        });

        this._throttledUpdate = this._throttledUpdate || _.throttle(this._updateUser.bind(this), 60000);
        return this._throttledUpdate();
    },

    track: function(eventName) {
        this._checkReady();

        var rulesContainEvent = this._rulesContainEvent(eventName);

        if (rulesContainEvent) {
            this._eventCollection.create({
                name: eventName,
                user: this.user
            }, {
                success: _.bind(this._checkConversationState, this)
            });
        } else {
            this._ensureEventExists(eventName);
        }
    },

    _ensureEventExists: function(eventName) {
        var hasEvent = this._hasEvent(eventName);

        if (!hasEvent) {
            endpoint.put('api/event', {
                name: eventName
            }).then(_.bind(function() {
                this._eventCollection.add({
                    name: eventName,
                    user: this.user
                });
            }, this))
                .done();
        }
    },

    _rulesContainEvent: function(eventName) {
        return !!this._ruleCollection.find(function(rule) {
            return !!rule.get('events').findWhere({
                name: eventName
            });
        });
    },

    _hasEvent: function(eventName) {
        return eventName === 'skt-appboot' || !!this._eventCollection.findWhere({
            name: eventName
        });
    },

    _checkConversationState: function() {

        if (!this._chatController.conversation || this._chatController.conversation.isNew()) {
            this._chatController._initConversation();
        }
    },

    _renderWidget: function() {
        this._chatController.getWidget().then(_.bind(function(widget) {
            $('body').append(widget.el);


            _(function() {
                this._chatController.scrollToBottom();
            }).chain().bind(this).delay();

            // Tell the world we're ready
            this.triggerMethod('ready');
        }, this));

    },

    onReady: function() {
        this.ready = true;
        this.track('skt-appboot');
    },

    onDestroy: function() {
        if (this.ready) {
            this._ruleCollection.reset();
            this._eventCollection.reset();
            this._conversations.reset();
            this._chatController.destroy();

            // delete the deviceid cookie
            document.cookie = SK_STORAGE + '=; expires=Thu, 01 Jan 1970 00:00:01 GMT;';

            endpoint.reset();

            this.ready = false;
        }
    },

    __showNotification: function(){
        this._chatController.__showNotification();
    }
});

module.exports = global.SupportKit = new SupportKit();
