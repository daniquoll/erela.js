> Erela was transferred to MenuDocs, because I no longer wish to work with Discord related development. It will from now on be maintained by [MenuDocs](https://github.com/MenuDocs). ~ @Solaris9

## Documentation & Guides

-   [Documentation](https://guides.menudocs.org/topics/erelajs/basics.html 'Erela.js Documentation')

## Prerequisites

-   Java - [Azul](https://www.azul.com/downloads/zulu-community/?architecture=x86-64-bit&package=jdk 'Download Azul OpenJDK'), [Adopt](https://adoptopenjdk.net/ 'Download Adopt OpenJDK') or [sdkman](https://sdkman.io/install 'Download sdkman')

-   [Lavalink](https://github.com/lavalink-devs/Lavalink/releases 'Download Lavalink') ([requirements](https://github.com/lavalink-devs/Lavalink?tab=readme-ov-file#requirements))

## Installation

```bash
npm install daniquoll/erela.js
```

**Note**: _Node **v16** is required!_

## Getting Started

-   Create an application.yml file in your working directory and copy the [example](https://lavalink.dev/configuration/#example-applicationyml 'application.yml file') into the created file and edit it with your configuration.

-   Run the jar file by running `java -jar Lavalink.jar` in a Terminal window.

## Example usage

```js
// Require both libraries
const { Client } = require('discord.js')
const { Manager } = require('erela.js')

// Initiate both main classes
const client = new Client()

// Define some options for the node
const nodes = [
    {
        host: 'localhost',
        password: 'youshallnotpass',
        port: 2333
    }
]

// Assign Manager to the client variable
client.manager = new Manager({
    // The nodes to connect to, optional if using default lavalink options
    nodes,
    // Method to send voice data to Discord
    send: (id, payload) => {
        const guild = client.guilds.cache.get(id)
        // NOTE: FOR ERIS YOU NEED JSON.stringify() THE PAYLOAD
        if (guild) guild.shard.send(payload)
    }
})

// Emitted whenever a node connects
client.manager.on('nodeConnect', node => {
    console.log(`Node "${node.options.identifier}" connected.`)
})

// Emitted whenever a node encountered an error
client.manager.on('nodeError', (node, error) => {
    console.log(`Node "${node.options.identifier}" encountered an error: ${error.message}.`)
})

// Listen for when the client becomes ready
client.once('ready', () => {
    // Initiates the manager and connects to all the nodes
    client.manager.init(client.user.id)
    console.log(`Logged in as ${client.user.tag}`)
})

// THIS IS REQUIRED. Send raw events to Erela.js
client.on('raw', d => client.manager.updateVoiceState(d))

// Finally login at the END of your code
client.login('your bot token here')
```

## Contributors

👤 **Solaris**

-   Author
-   Website: <https://solaris.codes/>
-   Github: [@Solaris9](https://github.com/Solaris9)

👤 **Anish Shobith**

-   Contributor
-   Github: [@Anish-Shobith](https://github.com/Anish-Shobith)

👤 **melike2d**

-   Contributor
-   Github: [@melike2d](https://github.com/melike2d)

👤 **ayntee**

-   Contributor
-   Github: [@ayntee](https://github.com/ayntee)
