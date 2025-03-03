## 证书相关

```cmd
# 生成 CA 私钥并使用 AES-256 加密
openssl genpkey -algorithm RSA -out ca.key -aes256

# 生成 CA 证书签名请求
openssl req -new -key ca.key -out ca.csr

# 生成自签名 CA 证书
openssl req -x509 -days 365 -key ca.key -in ca.csr -out ca.crt

# 生成服务器私钥
openssl genpkey -algorithm RSA -out server.key -aes256

# 生成服务器 CSR
openssl req -new -key server.key -out server.csr

# 使用 CA 签名服务器证书
openssl x509 -req -days 365 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt

# 生成客户端私钥
openssl genpkey -algorithm RSA -out client.key -aes256

# 生成客户端 CSR
openssl req -new -key client.key -out client.csr

# 使用 CA 签名客户端证书
openssl x509 -req -days 365 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt
```