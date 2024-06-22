import { Transform } from 'stream'
import crypto from 'crypto'

/**
 * 密钥
 */
let key = "832c5fad98e071148c12fbb24ca99ba102b4cf0223d28f0388e95c7f208c969a"
const encryptionKey = Buffer.from(key, 'hex'); // 32 bytes = 256 bits
const iv = Buffer.from('f70f2b8b38630264f424a8a4c4c38c56', 'hex')
// 加密函数
function encryptText(text, key, iv) {
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return encrypted.toString('hex')
}

// 解密函数
function decryptText(text, key, iv) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
    let decrypted = decipher.update(Buffer.from(text, 'hex'));
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}


/**
 * 加密管道
 */
export class EncoderPipe extends Transform {
    _transform(chunk, encoding, callback) {
        // 加密
        let data = encryptText(chunk, encryptionKey, iv)
        callback(null, data); // 传递原始或修改后的数据
    }

    _flush(callback) {
        // 调用 callback 以完成流处理
        callback();
    }
}


/**
 * 解密管道
 */
export class DecoderPipe extends Transform {
    _transform(chunk, encoding, callback) {
        // 加密
        let data = decryptText(chunk.toString(), encryptionKey, iv)
        callback(null, data); // 传递原始或修改后的数据
    }

    _flush(callback) {
        // 调用 callback 以完成流处理
        callback();
    }
}
