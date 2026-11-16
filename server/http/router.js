'use strict';
// openvibe-sdk/site (0.174.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// express.Router() whose async handlers send a rejection to next(err).
const express = require('express');
const site = require('openvibe-sdk/site');

module.exports = { asyncRouter: () => site.asyncRouter(express.Router()) };
