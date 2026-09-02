'use strict';

const Homey = require('homey');

class BearBlindsApp extends Homey.App {
    async onInit() {
        this.log('Bear blinds is running...');
    }
}

module.exports = BearBlindsApp;
