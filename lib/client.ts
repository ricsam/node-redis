import RedisSocket, { RedisSocketOptions } from './socket';
import RedisCommandsQueue, { PubSubListener, PubSubSubscribeCommands, PubSubUnsubscribeCommands, QueueCommandOptions } from './commands-queue';
import COMMANDS from './commands';
import { RedisCommand, RedisModules, RedisReply } from './commands';
import RedisMultiCommand, { MultiQueuedCommand, RedisMultiCommandType } from './multi-command';
import EventEmitter from 'events';
import { CommandOptions, commandOptions, isCommandOptions } from './command-options';
import { RedisLuaScript, RedisLuaScripts } from './lua-script';
import { ScanOptions, ZMember } from './commands/generic-transformers';
import { ScanCommandOptions } from './commands/SCAN';
import { HScanTuple } from './commands/HSCAN';
import { encodeCommand, extendWithDefaultCommands, extendWithModulesAndScripts, transformCommandArguments } from './commander';
import { Pool, Options as PoolOptions, createPool } from 'generic-pool';
import { ClientClosedError } from './errors';

export interface RedisClientOptions<M = RedisModules, S = RedisLuaScripts> {
    socket?: RedisSocketOptions;
    modules?: M;
    scripts?: S;
    commandsQueueMaxLength?: number;
    readonly?: boolean;
    legacyMode?: boolean;
    isolationPoolOptions?: PoolOptions;
}

export type RedisCommandSignature<C extends RedisCommand> =
    (...args: Parameters<C['transformArguments']> | [options: CommandOptions<ClientCommandOptions>, ...rest: Parameters<C['transformArguments']>]) => Promise<ReturnType<C['transformReply']>>;

type WithCommands = {
    [P in keyof typeof COMMANDS]: RedisCommandSignature<(typeof COMMANDS)[P]>;
};

type WithModules<M extends RedisModules> = {
    [P in keyof M]: {
        [C in keyof M[P]]: RedisCommandSignature<M[P][C]>;
    };
};

type WithScripts<S extends RedisLuaScripts> = {
    [P in keyof S]: RedisCommandSignature<S[P]>;
};

export type WithPlugins<M extends RedisModules, S extends RedisLuaScripts> =
    WithCommands & WithModules<M> & WithScripts<S>;

export type RedisClientType<M extends RedisModules, S extends RedisLuaScripts> =
    WithPlugins<M, S> & RedisClient<M, S>;

export interface ClientCommandOptions extends QueueCommandOptions {
    isolated?: boolean;
}

export default class RedisClient<M extends RedisModules = RedisModules, S extends RedisLuaScripts = RedisLuaScripts> extends EventEmitter {
    static commandOptions(options: ClientCommandOptions): CommandOptions<ClientCommandOptions> {
        return commandOptions(options);
    }

    static async commandsExecutor(
        this: RedisClient,
        command: RedisCommand,
        args: Array<unknown>
    ): Promise<ReturnType<typeof command['transformReply']>> {
        const { args: redisArgs, options } = transformCommandArguments<ClientCommandOptions>(command, args);

        const reply = command.transformReply(
            await this.#sendCommand(redisArgs, options),
            redisArgs.preserve
        );

        return reply;
    }

    static async #scriptsExecutor(
        this: RedisClient,
        script: RedisLuaScript,
        args: Array<unknown>
    ): Promise<typeof script['transformArguments']> {
        const { args: redisArgs, options } = transformCommandArguments<ClientCommandOptions>(script, args);

        const reply = script.transformReply(
            await this.executeScript(script, redisArgs, options),
            redisArgs.preserve
        );

        return reply;
    }

    static create<M extends RedisModules, S extends RedisLuaScripts>(options?: RedisClientOptions<M, S>): RedisClientType<M, S> {
        const Client = (<any>extendWithModulesAndScripts({
            BaseClass: RedisClient,
            modules: options?.modules,
            modulesCommandsExecutor: RedisClient.commandsExecutor,
            scripts: options?.scripts,
            scriptsExecutor: RedisClient.#scriptsExecutor
        }));

        if (Client !== RedisClient) {
            Client.prototype.Multi = RedisMultiCommand.extend(options);
        }

        return new Client(options);
    }

    readonly #options?: RedisClientOptions<M, S>;
    readonly #socket: RedisSocket;
    readonly #queue: RedisCommandsQueue;
    readonly #isolationPool: Pool<RedisClientType<M, S>>;
    readonly #v4: Record<string, any> = {};
    #selectedDB = 0;

    get options(): RedisClientOptions<M> | null | undefined {
        return this.#options;
    }

    get isOpen(): boolean {
        return this.#socket.isOpen;
    }

    get v4(): Record<string, any> {
        if (!this.#options?.legacyMode) {
            throw new Error('the client is not in "legacy mode"');
        }

        return this.#v4;
    }

    constructor(options?: RedisClientOptions<M, S>) {
        super();
        this.#options = options;
        this.#socket = this.#initiateSocket();
        this.#queue = this.#initiateQueue();
        this.#isolationPool = createPool({
            create: async () => {
                const duplicate = this.duplicate();
                await duplicate.connect();
                return duplicate;
            },
            destroy: client => client.disconnect()
        }, options?.isolationPoolOptions);
        this.#legacyMode();
    }

    #initiateSocket(): RedisSocket {
        const socketInitiator = async (): Promise<void> => {
            const v4Commands = this.#options?.legacyMode ? this.#v4 : this,
                promises = [];

            if (this.#selectedDB !== 0) {
                promises.push(v4Commands.select(RedisClient.commandOptions({ asap: true }), this.#selectedDB));
            }

            if (this.#options?.readonly) {
                promises.push(v4Commands.readonly(RedisClient.commandOptions({ asap: true })));
            }

            if (this.#options?.socket?.username || this.#options?.socket?.password) {
                promises.push(v4Commands.auth(RedisClient.commandOptions({ asap: true }), this.#options.socket));
            }

            const resubscribePromise = this.#queue.resubscribe();
            if (resubscribePromise) {
                promises.push(resubscribePromise);
                this.#tick();
            }

            await Promise.all(promises);
        };

        return new RedisSocket(socketInitiator, this.#options?.socket)
            .on('data', data => this.#queue.parseResponse(data))
            .on('error', err => {
                this.emit('error', err);
                this.#queue.flushWaitingForReply(err);
            })
            .on('connect', () => this.emit('connect'))
            .on('ready', () => {
                this.emit('ready');
                this.#tick();
            })
            .on('reconnecting', () => this.emit('reconnecting'))
            .on('end', () => this.emit('end'));
    }

    #initiateQueue(): RedisCommandsQueue {
        return new RedisCommandsQueue(
            this.#options?.commandsQueueMaxLength,
            encodedCommands => this.#socket.write(encodedCommands)
        );
    }

    #legacyMode(): void {
        if (!this.#options?.legacyMode) return;

        (this as any).#v4.sendCommand = this.#sendCommand.bind(this);
        (this as any).sendCommand = (...args: Array<unknown>): void => {
            const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] as Function : undefined,
                actualArgs = !callback ? args : args.slice(0, -1);
            this.#sendCommand(actualArgs.flat() as Array<string>)
                .then((reply: unknown) => {
                    if (!callback) return;

                    // https://github.com/NodeRedis/node-redis#commands:~:text=minimal%20parsing

                    callback(null, reply);
                })
                .catch((err: Error) => {
                    if (!callback) {
                        this.emit('error', err);
                        return;
                    }

                    callback(err);
                });
        };

        for (const name of Object.keys(COMMANDS)) {
            this.#defineLegacyCommand(name);
        }

        // hard coded commands
        this.#defineLegacyCommand('SELECT');
        this.#defineLegacyCommand('select');
        this.#defineLegacyCommand('SUBSCRIBE');
        this.#defineLegacyCommand('subscribe');
        this.#defineLegacyCommand('PSUBSCRIBE');
        this.#defineLegacyCommand('pSubscribe');
        this.#defineLegacyCommand('UNSUBSCRIBE');
        this.#defineLegacyCommand('unsubscribe');
        this.#defineLegacyCommand('PUNSUBSCRIBE');
        this.#defineLegacyCommand('pUnsubscribe');
        this.#defineLegacyCommand('QUIT');
        this.#defineLegacyCommand('quit');
    }

    #defineLegacyCommand(name: string): void {
        (this as any).#v4[name] = (this as any)[name].bind(this);
        (this as any)[name] = (...args: Array<unknown>): void => {
            (this as any).sendCommand(name, ...args);
        };
    }

    duplicate(): RedisClientType<M, S> {
        return new (Object.getPrototypeOf(this).constructor)(this.#options);
    }

    async connect(): Promise<void> {
        await this.#socket.connect();
    }

    async SELECT(db: number): Promise<void>;
    async SELECT(options: CommandOptions<ClientCommandOptions>, db: number): Promise<void>;
    async SELECT(options?: any, db?: any): Promise<void> {
        if (!isCommandOptions(options)) {
            db = options;
            options = null;
        }

        await this.#sendCommand(['SELECT', db.toString()], options);
        this.#selectedDB = db;
    }

    select = this.SELECT;

    SUBSCRIBE(channels: string | Array<string>, listener: PubSubListener): Promise<void> {
        return this.#subscribe(PubSubSubscribeCommands.SUBSCRIBE, channels, listener);
    }

    subscribe = this.SUBSCRIBE;

    PSUBSCRIBE(patterns: string | Array<string>, listener: PubSubListener): Promise<void> {
        return this.#subscribe(PubSubSubscribeCommands.PSUBSCRIBE, patterns, listener);
    }

    pSubscribe = this.PSUBSCRIBE;

    #subscribe(command: PubSubSubscribeCommands, channels: string | Array<string>, listener: PubSubListener): Promise<void> {
        const promise = this.#queue.subscribe(command, channels, listener);
        this.#tick();
        return promise;
    }

    UNSUBSCRIBE(channels?: string | Array<string>, listener?: PubSubListener): Promise<void> {
        return this.#unsubscribe(PubSubUnsubscribeCommands.UNSUBSCRIBE, channels, listener);
    }

    unsubscribe = this.UNSUBSCRIBE;

    PUNSUBSCRIBE(patterns?: string | Array<string>, listener?: PubSubListener): Promise<void> {
        return this.#unsubscribe(PubSubUnsubscribeCommands.PUNSUBSCRIBE, patterns, listener);
    }

    pUnsubscribe = this.PUNSUBSCRIBE;

    #unsubscribe(command: PubSubUnsubscribeCommands, channels?: string | Array<string>, listener?: PubSubListener): Promise<void> {
        const promise = this.#queue.unsubscribe(command, channels, listener);
        this.#tick();
        return promise;
    }

    QUIT(): Promise<void> {
        return this.#socket.quit(() => {
            const promise = this.#queue.addEncodedCommand(encodeCommand(['QUIT']));
            this.#tick();
            return promise;
        });
    }

    quit = this.QUIT;

    sendCommand<T = unknown>(args: Array<string>, options?: ClientCommandOptions): Promise<T> {
        return this.#sendCommand(args, options);
    }

    // using `#sendCommand` cause `sendCommand` is overwritten in legacy mode
    #sendCommand<T = RedisReply>(args: Array<string>, options?: ClientCommandOptions): Promise<T> {
        return this.sendEncodedCommand(encodeCommand(args), options);
    }

    async sendEncodedCommand<T = RedisReply>(encodedCommand: string, options?: ClientCommandOptions): Promise<T> {
        if (!this.#socket.isOpen) {
            throw new ClientClosedError();
        }

        if (options?.isolated) {
            return this.executeIsolated(isolatedClient =>
                isolatedClient.sendEncodedCommand(encodedCommand, {
                    ...options,
                    isolated: false
                })
            );
        }

        const promise = this.#queue.addEncodedCommand<T>(encodedCommand, options);
        this.#tick();
        return await promise;
    }

    executeIsolated<T>(fn: (client: RedisClientType<M, S>) => T | Promise<T>): Promise<T> {
        return this.#isolationPool.use(fn);
    }

    async executeScript(script: RedisLuaScript, args: Array<string>, options?: ClientCommandOptions): Promise<ReturnType<typeof script['transformReply']>> {
        try {
            return await this.#sendCommand([
                'EVALSHA',
                script.SHA1,
                script.NUMBER_OF_KEYS.toString(),
                ...args
            ], options);
        } catch (err: any) {
            if (!err?.message?.startsWith?.('NOSCRIPT')) {
                throw err;
            }

            return await this.#sendCommand([
                'EVAL',
                script.SCRIPT,
                script.NUMBER_OF_KEYS.toString(),
                ...args
            ], options);
        }
    }

    #multiExecutor(commands: Array<MultiQueuedCommand>, chainId?: symbol): Promise<Array<RedisReply>> {
        const promise = Promise.all(
            commands.map(({encodedCommand}) => {
                return this.#queue.addEncodedCommand(encodedCommand, RedisClient.commandOptions({
                    chainId
                }));
            })
        );

        this.#tick();

        return promise;
    }

    multi(): RedisMultiCommandType<M, S> {
        return new (this as any).Multi(
            this.#multiExecutor.bind(this),
            this.#options
        );
    }

    async* scanIterator(options?: ScanCommandOptions): AsyncIterable<string> {
        let cursor = 0;
        do {
            const reply = await (this as any).scan(cursor, options);
            cursor = reply.cursor;
            for (const key of reply.keys) {
                yield key;
            }
        } while (cursor !== 0)
    }

    async* hScanIterator(key: string, options?: ScanOptions): AsyncIterable<HScanTuple> {
        let cursor = 0;
        do {
            const reply = await (this as any).hScan(key, cursor, options);
            cursor = reply.cursor;
            for (const tuple of reply.tuples) {
                yield tuple;
            }
        } while (cursor !== 0)
    }

    async* sScanIterator(key: string, options?: ScanOptions): AsyncIterable<string> {
        let cursor = 0;
        do {
            const reply = await (this as any).sScan(key, cursor, options);
            cursor = reply.cursor;
            for (const member of reply.members) {
                yield member;
            }
        } while (cursor !== 0)
    }

    async* zScanIterator(key: string, options?: ScanOptions): AsyncIterable<ZMember> {
        let cursor = 0;
        do {
            const reply = await (this as any).zScan(key, cursor, options);
            cursor = reply.cursor;
            for (const member of reply.members) {
                yield member;
            }
        } while (cursor !== 0)
    }

    async disconnect(): Promise<void> {
        this.#queue.flushAll(new Error('Disconnecting'));
        await Promise.all([
            this.#socket.disconnect(),
            this.#destroyIsolationPool()
        ]);
    }

    async #destroyIsolationPool(): Promise<void> {
        await this.#isolationPool.drain();
        await this.#isolationPool.clear();
    }

    #isTickQueued = false;

    #tick(): void {
        const {chunkRecommendedSize} = this.#socket;
        if (!chunkRecommendedSize) {
            return;
        }

        if (!this.#isTickQueued && this.#queue.waitingToBeSentCommandsLength < chunkRecommendedSize) {
            queueMicrotask(() => this.#tick());
            this.#isTickQueued = true;
            return;
        }

        const isBuffering = this.#queue.executeChunk(chunkRecommendedSize);
        if (isBuffering === true) {
            this.#socket.once('drain', () => this.#tick());
        } else if (isBuffering === false) {
            this.#tick();
            return;
        }

        this.#isTickQueued = false;
    }
}

extendWithDefaultCommands(RedisClient, RedisClient.commandsExecutor);
(RedisClient.prototype as any).Multi = RedisMultiCommand.extend();
