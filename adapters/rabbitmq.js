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
    this.maxReconnectDelay = config.maxReconnectDelay || 30000;
    this.heartbeat = config.heartbeat || 30;
    this.prefetch = config.prefetch || 1;

    this.connection = null;
    this.publishChannel = null;
    this.consumeChannel = null;
    this.connecting = null;

    // Tracks active consumers so they can be re-registered after a reconnect
    this.consumers = [];

    // Tracks reconnect attempts for backoff calculation
    this.reconnectAttempt = 0;

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

      const connection = await amqp.connect(this.url, {
        heartbeat: this.heartbeat,
      });

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

      this.publishChannel.on("error", (error) => {
        console.error("RabbitMQ publish channel error:", error);
      });

      this.publishChannel.on("close", () => {
        console.warn("RabbitMQ publish channel closed");
        this.publishChannel = null;
      });

      // Channel for consuming
      this.consumeChannel = await connection.createChannel();

      this.consumeChannel.on("error", (error) => {
        console.error("RabbitMQ consume channel error:", error);
      });

      this.consumeChannel.on("close", () => {
        console.warn("RabbitMQ consume channel closed");
        this.consumeChannel = null;
      });

      await this.consumeChannel.prefetch(this.prefetch);

      console.log("RabbitMQ connected");

      // Reset backoff on a successful connection
      this.reconnectAttempt = 0;

      // Re-register any consumers that were active before a disconnect
      await this._resumeConsumers();
    } catch (error) {
      this.connection = null;
      this.publishChannel = null;
      this.consumeChannel = null;

      console.error("RabbitMQ connection failed:", error);

      throw error;
    }
  }

  _reconnect() {
    this.reconnectAttempt += 1;

    const delay = Math.min(
      this.reconnectDelay * this.reconnectAttempt,
      this.maxReconnectDelay,
    );

    console.log(
      `RabbitMQ reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`,
    );

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error("RabbitMQ reconnect failed:", error);

        this._reconnect();
      }
    }, delay);
  }

  async publish(exchangeName, data, options = {}) {
    await this.connect();

    if (!this.publishChannel) {
      throw new Error("RabbitMQ publish channel is not available");
    }

    await this.publishChannel.assertExchange(exchangeName, "fanout", {
      durable: true,
    });

    const message = Buffer.from(JSON.stringify(data));

    this.publishChannel.publish(exchangeName, "", message, {
      persistent: true,
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

    // Remember this consumer so it can be replayed after a reconnect.
    // Guards against duplicate registration if consume() is called again
    // for the same queue (e.g. manually, not via _resumeConsumers).
    if (!this.consumers.find((c) => c.queue === queue)) {
      this.consumers.push({ queue, handler, options });
    }

    console.log(`RabbitMQ consumer started: ${queue}`);
  }

  async _resumeConsumers() {
    if (this.consumers.length === 0) {
      return;
    }

    console.log(`Resuming ${this.consumers.length} RabbitMQ consumer(s)...`);

    // consume() re-populates this.consumers, so snapshot and clear first
    const consumers = [...this.consumers];
    this.consumers = [];

    for (const { queue, handler, options } of consumers) {
      try {
        await this.consume(queue, handler, options);
      } catch (error) {
        console.error(`Failed to resume consumer for ${queue}:`, error);
      }
    }
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
    // Prevent auto-reconnect from firing during a deliberate shutdown
    this.consumers = [];

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
