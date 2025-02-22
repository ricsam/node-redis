import { RedisCommand, RedisModules } from './commands';
import RedisClient, { ClientCommandOptions, RedisClientType, WithPlugins } from './client';
import { RedisSocketOptions } from './socket';
import RedisClusterSlots, { ClusterNode } from './cluster-slots';
import { RedisLuaScript, RedisLuaScripts } from './lua-script';
import { extendWithModulesAndScripts, extendWithDefaultCommands, transformCommandArguments } from './commander';
import RedisMultiCommand, { MultiQueuedCommand, RedisMultiCommandType } from './multi-command';
import { EventEmitter } from 'events';

export interface RedisClusterOptions<M = RedisModules, S = RedisLuaScripts> {
    rootNodes: Array<RedisSocketOptions>;
    modules?: M;
    scripts?: S;
    useReplicas?: boolean;
    maxCommandRedirections?: number;
}

export type RedisClusterType<M extends RedisModules, S extends RedisLuaScripts> =
    WithPlugins<M, S> & RedisCluster;

export default class RedisCluster<M extends RedisModules = RedisModules, S extends RedisLuaScripts = RedisLuaScripts> extends EventEmitter {
    static #extractFirstKey(command: RedisCommand, originalArgs: Array<unknown>, redisArgs: Array<string>): string | undefined {
        if (command.FIRST_KEY_INDEX === undefined) {
            return undefined;
        } else if (typeof command.FIRST_KEY_INDEX === 'number') {
            return redisArgs[command.FIRST_KEY_INDEX];
        }

        return command.FIRST_KEY_INDEX(...originalArgs);
    }

    static async commandsExecutor(
        this: RedisCluster,
        command: RedisCommand,
        args: Array<unknown>
    ): Promise<ReturnType<typeof command['transformReply']>> {
        const { args: redisArgs, options } = transformCommandArguments<ClientCommandOptions>(command, args);

        const reply = command.transformReply(
            await this.sendCommand(
                RedisCluster.#extractFirstKey(command, args, redisArgs),
                command.IS_READ_ONLY,
                redisArgs,
                options
            ),
            redisArgs.preserve
        );

        return reply;
    }

    static async #scriptsExecutor(
        this: RedisCluster,
        script: RedisLuaScript,
        args: Array<unknown>
    ): Promise<typeof script['transformArguments']> {
        const { args: redisArgs, options } = transformCommandArguments<ClientCommandOptions>(script, args);

        const reply = script.transformReply(
            await this.executeScript(
                script,
                args,
                redisArgs,
                options
            ),
            redisArgs.preserve
        );

        return reply;
    }

    static create<M extends RedisModules, S extends RedisLuaScripts>(options?: RedisClusterOptions<M, S>): RedisClusterType<M, S> {
        return new (<any>extendWithModulesAndScripts({
            BaseClass: RedisCluster,
            modules: options?.modules,
            modulesCommandsExecutor: RedisCluster.commandsExecutor,
            scripts: options?.scripts,
            scriptsExecutor: RedisCluster.#scriptsExecutor
        }))(options);
    }

    readonly #options: RedisClusterOptions;
    readonly #slots: RedisClusterSlots<M, S>;
    readonly #Multi: new (...args: ConstructorParameters<typeof RedisMultiCommand>) => RedisMultiCommandType<M, S>;

    constructor(options: RedisClusterOptions<M, S>) {
        super();

        this.#options = options;
        this.#slots = new RedisClusterSlots(options, err => this.emit('error', err));
        this.#Multi = RedisMultiCommand.extend(options);
    }

    duplicate(): RedisClusterOptions<M, S> {
        return new (Object.getPrototypeOf(this).constructor)(this.#options);
    }

    async connect(): Promise<void> {
        return this.#slots.connect();
    }

    async sendCommand<C extends RedisCommand>(
        firstKey: string | undefined,
        isReadonly: boolean | undefined,
        args: Array<string>,
        options?: ClientCommandOptions,
        redirections = 0
    ): Promise<ReturnType<C['transformReply']>> {
        const client = this.#slots.getClient(firstKey, isReadonly);

        try {
            return await client.sendCommand(args, options);
        } catch (err: any) {
            const shouldRetry = await this.#handleCommandError(err, client, redirections);
            if (shouldRetry === true) {
                return this.sendCommand(firstKey, isReadonly, args, options, redirections + 1);
            } else if (shouldRetry) {
                return shouldRetry.sendCommand(args, options);
            }

            throw err;
        }
    }

    async executeScript(
        script: RedisLuaScript,
        originalArgs: Array<unknown>,
        redisArgs: Array<string>,
        options?: ClientCommandOptions,
        redirections = 0
    ): Promise<ReturnType<typeof script['transformReply']>> {
        const client = this.#slots.getClient(
            RedisCluster.#extractFirstKey(script, originalArgs, redisArgs),
            script.IS_READ_ONLY
        );

        try {
            return await client.executeScript(script, redisArgs, options);
        } catch (err: any) {
            const shouldRetry = await this.#handleCommandError(err, client, redirections);
            if (shouldRetry === true) {
                return this.executeScript(script, originalArgs, redisArgs, options, redirections + 1);
            } else if (shouldRetry) {
                return shouldRetry.executeScript(script, redisArgs, options);
            }

            throw err;
        }
    }

    async #handleCommandError(err: Error, client: RedisClientType<M, S>, redirections: number): Promise<boolean | RedisClientType<M, S>> {
        if (redirections > (this.#options.maxCommandRedirections ?? 16)) {
            throw err;
        }

        if (err.message.startsWith('ASK')) {
            const url = err.message.substring(err.message.lastIndexOf(' ') + 1);
            let node = this.#slots.getNodeByUrl(url);
            if (!node) {
                await this.#slots.discover(client);
                node = this.#slots.getNodeByUrl(url);

                if (!node) {
                    throw new Error(`Cannot find node ${url}`);
                }
            }

            await node.client.asking();
            return node.client;
        } else if (err.message.startsWith('MOVED')) {
            await this.#slots.discover(client);
            return true;
        }

        throw err;
    }

    multi(routing: string): RedisMultiCommandType<M, S> {
        return new this.#Multi(
            async (commands: Array<MultiQueuedCommand>, chainId?: symbol) => {
                const client = this.#slots.getClient(routing);

                return Promise.all(
                    commands.map(({encodedCommand}) => {
                        return client.sendEncodedCommand(encodedCommand, RedisClient.commandOptions({
                            chainId
                        }));
                    })
                );
            },
            this.#options
        );
    }

    getMasters(): Array<ClusterNode<M, S>> {
        return this.#slots.getMasters();
    }

    getSlotMaster(slot: number): ClusterNode<M, S> {
        return this.#slots.getSlotMaster(slot);
    }

    disconnect(): Promise<void> {
        return this.#slots.disconnect();
    }
}

extendWithDefaultCommands(RedisCluster, RedisCluster.commandsExecutor);

