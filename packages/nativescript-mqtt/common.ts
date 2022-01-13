import { Qos, Message } from './paho-mqtt';

export { Message };
export interface IEvent<T> {
    on(handler: { (data?: T): void }): void;
    off(handler?: { (data?: T): void }): void;
}

export class EventHandler<T> implements IEvent<T> {
    private handlers: { (data?: T): void; }[] = [];

    public on(handler: { (data?: T): void }) {
        this.handlers.push(handler);
    }

    public off(handler?: { (data?: T): void }) {
        this.handlers = handler ? this.handlers.filter(h => h !== handler) : [];
    }

    public trigger(data?: T) {
        this.handlers.slice(0).forEach(h => h(data));
    }
}

// class Message {
//     public payload: string;
//     public bytes: ArrayBuffer;
//     public topic: string;
//     public qos: Qos;
//     public retained: boolean;
//     constructor(
//         mqttMessage: {
//             payloadString?: string,
//             payloadBytes?: ArrayBuffer,
//             destinationName?: string,
//             qos?: Qos,
//             retained?: boolean;
//         }
//     ) {
//         this.payload = mqttMessage.payloadString || '';
//         this.bytes = mqttMessage.payloadBytes || null;
//         this.topic = mqttMessage.destinationName || '';
//         this.qos = mqttMessage.qos || 0;
//         this.retained = mqttMessage.retained || false;
//     }
// }

export function guid(): string {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
        s4() + '-' + s4() + s4() + s4();
};
