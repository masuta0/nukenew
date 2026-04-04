// stop.js - Command utility for stopping music playback

const { stopMusic } = require('./musicManager');

const stopCommand = (message) => {
    stopMusic();
    message.channel.send('Music playback has been stopped.');
};

module.exports = stopCommand;