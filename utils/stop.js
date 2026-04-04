// utils/stop.js

const { getVoiceConnection } = require('@discordjs/voice');

function handleStopCommand(interaction) {
    const guildId = interaction.guild.id;
    const voiceConnection = getVoiceConnection(guildId);

    if (!voiceConnection) {
        return interaction.reply({ 
            content: 'ボイスチャンネルに接続していません。',
            ephemeral: true 
        });
    }

    const player = voiceConnection.state.subscription?.player;

    if (player) {
        player.stop();
        voiceConnection.destroy();
        return interaction.reply({ 
            content: '音楽の再生を停止し、ボイスチャンネルから切断しました。',
            ephemeral: false 
        });
    } else {
        return interaction.reply({ 
            content: '現在、再生中の音楽はありません。',
            ephemeral: true 
        });
    }
}

module.exports = {
    handleStopCommand
};
