import { Observable, ObservableArray, EventData, Page } from '@nativescript/core';
import { DemoSharedNativescriptMqtt } from '@demo/shared';
import {  ConnectionOptions, ConnectionState, Message, MQTTClient, OnConnectedParams, Qos, ClientOptions } from '@edusperoni/nativescript-mqtt';

let model: DemoModel;
export function navigatingTo(args: EventData) {
	const page = <Page>args.object;
	if (model) {
        model.disposeClient();
    }
	model = new DemoModel();
	page.bindingContext = model;
}

interface MessageItem {
	topic: string;
	message: string;
	sent: boolean;
	retained: boolean;
	qos: Qos;
  }
  
  function isInt(v: string) {
	return !isNaN(+v) && +v === Math.floor(+v);
  }

export class DemoModel extends DemoSharedNativescriptMqtt {
	tfText = "ws://broker.mqttdashboard.com:8000/mqtt";
  host = "broker.mqttdashboard.com";
  port = "8000";
  path = "/mqtt";
  clientId = "";

  user = "";
  pass = "";
  keepalive = "";
  timeout = "";

  useSSL = false;
  cleanSession = true;
  autoReconnect = false;

  paramsVisible = "visible";
  connectVisible = "collapse";

  lockMessage = "";

  logView = "";

  qosItems = ["0", "1", "2"];
  subQos: Qos = 0;
  pubQos: Qos = 0;

  subTopic = "";
  pubTopic = "";
  pubMessage = "";
  subMessage = "";

  pubRetained = false;

  messageHistory = new ObservableArray<MessageItem>();

  get wsUri() {
    return `${this.useSSL ? 'wss://' : 'ws://'}${this.host}:${this.port}${this.path}`;
  }
  public message: string;
  private mqttClient: MQTTClient;
  private connectionTime = 0;

  constructor() {
    super();
  }

  validateConstructor() {
    return this.host && isInt(this.port) && isInt(this.keepalive) && isInt(this.timeout);
  }

  generateClient() {
    this.disposeClient();
    const clientOptions: ClientOptions = {
      clientId: this.clientId ? this.clientId : undefined,
      host: this.host,
      path: this.path,
      port: +this.port
    };
    this.mqttClient = new MQTTClient(clientOptions);

    this.mqttClient.onMessageDelivered.on((message) => {
      const msgObj = {
        destinationName: message.destinationName,
        payloadString: message.payloadString,
        duplicate: message.duplicate,
        retained: message.retained,
        qos: message.qos
      };
      this.messageHistory.push({
        topic: message.destinationName,
        message: message.payloadString,
        qos: message.qos,
        retained: message.retained,
        sent: true
      });
      this.logMessage("onMessageDelivered: " + JSON.stringify(msgObj));
    });

    this.mqttClient.onSubscribeSuccess.on((v) => {
      this.logMessage("onSubscribeSuccess: " + JSON.stringify(v));
    });

    this.mqttClient.onSubscribeFailure.on((v) => {
      this.logMessage("onSubscribeFailure: " + JSON.stringify(v));
    });

    this.mqttClient.onUnsubscribeSuccess.on(() => {
      this.logMessage("onUnsubscribeSuccess");
    });

    this.mqttClient.onUnsubscribeFailure.on((v) => {
      this.logMessage("onUnsubscribeFailure: " + JSON.stringify(v));
    });

    this.mqttClient.onConnected.on((v: OnConnectedParams) => {
      this.connectionTime = Date.now();
      this.logMessage("onConnected: " + JSON.stringify(v));
    });
    this.mqttClient.onConnectionSuccess.on(() => {
      this.logMessage("onConnectionSuccess");
    });

    this.mqttClient.onConnectionFailure.on((err) => {
      this.logMessage("onConnectionFailure: " + JSON.stringify(err));
    });

    this.mqttClient.onConnectionLost.on((err) => {
      const timeConnected = Date.now() - this.connectionTime;
      const minutes = Math.floor(timeConnected / 1000 / 60);
      const seconds = timeConnected / 1000 - minutes * 60;
      this.logMessage("onConnectionLost: " + JSON.stringify(err));
      console.log(`Time connected: ${minutes}m ${seconds}s`);
    });

    this.mqttClient.onMessageArrived.on((message: Message) => {
      const msgObj = {
        destinationName: message.destinationName,
        payloadString: message.payloadString,
        duplicate: message.duplicate,
        retained: message.retained,
        qos: message.qos
      };
      this.messageHistory.push({
        topic: message.destinationName,
        message: message.payloadString,
        qos: message.qos,
        retained: message.retained,
        sent: false
      });
      this.logMessage(`onMessageArrived: ` + JSON.stringify(msgObj));
    });
  }

  disposeClient() {
    if (this.mqttClient) {
      this.mqttClient.onConnected.off();
      this.mqttClient.onConnectionSuccess.off();
      this.mqttClient.onConnectionFailure.off();
      this.mqttClient.onConnectionLost.off();
      this.mqttClient.onMessageArrived.off();
      this.mqttClient.onMessageDelivered.off();
      this.mqttClient.onSubscribeFailure.off();
      this.mqttClient.onSubscribeSuccess.off();
      this.mqttClient.onUnsubscribeFailure.off();
      this.mqttClient.onUnsubscribeSuccess.off();
      this.mqttClient.disconnect();
      this.mqttClient = null;
      console.log("client disposed");
    }
    this.set("messageHistory", new ObservableArray<MessageItem>());
    this.set("logView", "");
  }

  connect() {
    this.generateClient();
    this.reconnect();
  }

  reconnect() {

    if (this.mqttClient.connectionState !== ConnectionState.DISCONNECTED) {
      this.logMessage(`Disconnecting`);
      this.mqttClient.disconnect();
    }
    this.logMessage(`Connecting to ${this.wsUri}`);
    const connOptions: ConnectionOptions = {
      cleanSession: this.cleanSession,
      reconnect: this.autoReconnect,
      useSSL: this.useSSL
    };
    if (this.keepalive) {
      connOptions.keepAliveInterval = +this.keepalive;
    }

    this.mqttClient.connect(connOptions);
  }

  subscribe() {
    if (this.subTopic) {
      const topic = this.subTopic;
      this.mqttClient.subscribe(topic, { qos: this.subQos }).then(
        (v) => this.logMessage(`(Promise) Subscribed to ${topic} ${JSON.stringify(v)}`),
        (e) => this.logMessage(`(Promise) Error subscribing to ${topic} ${JSON.stringify(e)}`)
      );
    }
  }

  unsubscribe() {
    if (this.subTopic) {
      const topic = this.subTopic;
      this.mqttClient.unsubscribe(topic).then(
        () => this.logMessage(`(Promise) Unsubscribed to ${topic}`),
        (e) => this.logMessage(`(Promise) Error unsubscribing to ${topic} ${JSON.stringify(e)}`)
      );
    }
  }
  sendMessage() {
    if (this.pubTopic) {
      const m = new Message(this.pubMessage);
      m.destinationName = this.pubTopic;
      m.qos = this.pubQos;
      m.retained = this.pubRetained;
      this.mqttClient.publish(m);
    }
  }

  private logMessage(m: string) {
    console.log(m);
    this.set("message", m);
    this.set("logView", this.logView + (this.logView ? "\n" : "") + '>' + m);
  }
	
}

// Event handler for Page 'loaded' event attached in main-page.xml

export function onReconnectTap() {
    model.reconnect();
}

export function onLockTap() {
    if (model.validateConstructor()) {
        model.set("lockMessage", "");
        model.set("paramsVisible", "collapse");
        model.set("connectVisible", "visible");
        model.connect();
    } else {
        model.set("lockMessage", "Invalid Parameters");
    }
}

export function onEditTap() {
    model.set("paramsVisible", "visible");
    model.set("connectVisible", "collapse");
    model.disposeClient();
}

export function onSubscribeTap() {
    model.subscribe();
}

export function onUnsubscribeTap() {
    model.unsubscribe();
}

export function onSendMessageTap() {
    model.sendMessage();
}
