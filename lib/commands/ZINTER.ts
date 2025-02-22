import { pushVerdictArgument, transformReplyStringArray } from './generic-transformers';

export const FIRST_KEY_INDEX = 2;

export const IS_READ_ONLY = true;

interface ZInterOptions {
    WEIGHTS?: Array<number>;
    AGGREGATE?: 'SUM' | 'MIN' | 'MAX';
}

export function transformArguments(keys: Array<string> | string, options?: ZInterOptions): Array<string> {
    const args = pushVerdictArgument(['ZINTER'], keys);

    if (options?.WEIGHTS) {
        args.push(
            'WEIGHTS',
            ...options.WEIGHTS.map(weight => weight.toString())
        );
    }

    if (options?.AGGREGATE) {
        args.push('AGGREGATE', options?.AGGREGATE);
    }

    return args;
}

export const transformReply = transformReplyStringArray;
