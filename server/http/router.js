'use strict';

/**
 * express.Router() whose get/post/patch/delete handlers may be async: a rejected promise goes to next(err)
 * (the app's error handler, which logs without request bodies) instead of becoming an unhandled rejection.
 */
const express = require('express');

function asyncRouter() {
    const r = express.Router();
    for (const method of ['get', 'post', 'patch', 'delete', 'put', 'all']) {
        const orig = r[method].bind(r);
        r[method] = (path, ...handlers) => orig(path, ...handlers.map((h) => (h.length === 4 ? h : (req, res, next) => {
            try {
                const out = h(req, res, next);
                if (out && typeof out.catch === 'function') out.catch(next);
            } catch (err) { next(err); }
        })));
    }
    return r;
}

module.exports = { asyncRouter };
