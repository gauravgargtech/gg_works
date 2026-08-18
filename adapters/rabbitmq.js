require("../config/config");

const amqp = require("amqplib");

class RabbitMQ {
  static instance = null;

  constructor(config = {}) {
    if (RabbitMQ.instance) {
      return RabbitMQ.instance;
    }

    this.url = config.url || process.env.RABBITMQ_URL;
    this.reconnectDelay = config.reconnectDelay || 5000;
    this.prefetch = config.prefetch || 10;

    this.connection = null;
    this.publishChannel = null;
    this.consumeChannel = null;
    this.connecting = null;

    RabbitMQ.instance = this;
  }

  static getInstance(config = {}) {
    if (!RabbitMQ.instance) {
      RabbitMQ.instance = new RabbitMQ(config);
    }

    return RabbitMQ.instance;
  }

  async connect() {
    // Already connected
    if (this.connection) {
      return;
    }

    // Connection already in progress
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this._createConnection();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async _createConnection() {
    try {
      console.log("Connecting to RabbitMQ...");

      const connection = await amqp.connect(this.url);

      this.connection = connection;

      connection.on("error", (error) => {
        console.error("RabbitMQ connection error:", error);
      });

      connection.on("close", () => {
        console.warn("RabbitMQ connection closed");

        this.connection = null;
        this.publishChannel = null;
        this.consumeChannel = null;

        this._reconnect();
      });

      // Channel for publishing
      this.publishChannel = await connection.createConfirmChannel();

      // Channel for consuming
      this.consumeChannel = await connection.createChannel();

      await this.consumeChannel.prefetch(this.prefetch);

      console.log("RabbitMQ connected");
    } catch (error) {
      this.connection = null;
      this.publishChannel = null;
      this.consumeChannel = null;

      console.error("RabbitMQ connection failed:", error);

      throw error;
    }
  }

  _reconnect() {
    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error("RabbitMQ reconnect failed:", error);

        this._reconnect();
      }
    }, this.reconnectDelay);
  }

  async publish(queue, data, options = {}) {
    await this.connect();

    if (!this.publishChannel) {
      throw new Error("RabbitMQ publish channel is not available");
    }

    await this.publishChannel.assertQueue(queue, {
      durable: true,
    });

    const message = Buffer.from(JSON.stringify(data));

    this.publishChannel.sendToQueue(queue, message, {
      persistent: true,
      contentType: "application/json",
      ...options,
    });

    // Wait for RabbitMQ confirmation
    await this.publishChannel.waitForConfirms();
  }

  async consume(queue, handler, options = {}) {
    await this.connect();

    if (!this.consumeChannel) {
      throw new Error("RabbitMQ consume channel is not available");
    }

    await this.consumeChannel.assertQueue(queue, {
      durable: true,
    });

    await this.consumeChannel.consume(
      queue,
      async (message) => {
        if (!message) {
          return;
        }

        try {
          const data = JSON.parse(message.content.toString());

          await handler(data, message);

          // Successfully processed
          this.consumeChannel.ack(message);
        } catch (error) {
          console.error(`Error processing ${queue}:`, error);

          // Requeue message
          this.consumeChannel.nack(message, false, true);
        }
      },
      {
        noAck: false,
        ...options,
      },
    );

    console.log(`RabbitMQ consumer started: ${queue}`);
  }

  async read(queue) {
    await this.connect();

    if (!this.consumeChannel) {
      throw new Error("RabbitMQ consume channel is not available");
    }

    await this.consumeChannel.assertQueue(queue, {
      durable: true,
    });

    const message = await this.consumeChannel.get(queue, {
      noAck: false,
    });

    if (!message) {
      return null;
    }

    try {
      const data = JSON.parse(message.content.toString());

      this.consumeChannel.ack(message);

      return data;
    } catch (error) {
      this.consumeChannel.nack(message, false, false);

      throw error;
    }
  }

  async close() {
    try {
      await this.publishChannel?.close();
    } catch (error) {}

    try {
      await this.consumeChannel?.close();
    } catch (error) {}

    try {
      await this.connection?.close();
    } catch (error) {}

    this.publishChannel = null;
    this.consumeChannel = null;
    this.connection = null;

    console.log("RabbitMQ closed");
  }
}

module.exports = RabbitMQ;
