/**
 * MQ 抽象 - 与具体实现解耦
 * 目标：业务代码仅依赖此抽象，可无缝切换 RabbitMQ / Redis PubSub / Kafka 等
 * 使用示例：
 *   const mq: MQ = new RabbitMQ({ url: "amqp://..." });
 *   await mq.connect();
 *   await mq.publish("order.created", { id: 1 });
 *   const off = await mq.subscribe("order.*", async (msg) => { ... });
 */

export interface MQMessage<T = unknown> {
  /** 消息唯一标识 */
  id: string;
  /** 主题/路由键，如 order.created */
  topic: string;
  /** 业务载荷 */
  payload: T;
  /** 发送时间戳（毫秒） */
  timestamp: number;
  /** 可选头部，用于链路追踪等 */
  headers?: Record<string, string>;
}

export interface PublishOptions {
  /** 额外头部 */
  headers?: Record<string, string>;
  /** 是否持久化（由实现决定） */
  persistent?: boolean;
}

/** 订阅回调，返回 Promise 用于支持异步 ack */
export type MessageHandler<T = unknown> = (msg: MQMessage<T>) => Promise<void> | void;

/** MQ 核心接口 */
export interface MQ {
  /** 建立连接 */
  connect(): Promise<void>;
  /** 断开连接 */
  disconnect(): Promise<void>;
  /** 连接状态 */
  isConnected(): boolean;
  /** 发布消息到指定主题 */
  publish<T>(topic: string, payload: T, opts?: PublishOptions): Promise<void>;
  /**
   * 订阅主题
   * @returns 取消订阅函数，调用后停止接收
   */
  subscribe<T>(topic: string, handler: MessageHandler<T>): Promise<() => Promise<void>>;
}

/** 抽象基类，提供 _connected 状态管理，子类只需实现具体协议 */
export abstract class BaseMQ implements MQ {
  /** 内部连接状态，由子类在 connect/disconnect 时维护 */
  protected _connected = false;

  isConnected(): boolean {
    return this._connected;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract publish<T>(topic: string, payload: T, opts?: PublishOptions): Promise<void>;
  abstract subscribe<T>(topic: string, handler: MessageHandler<T>): Promise<() => Promise<void>>;
}
