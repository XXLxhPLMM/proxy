# from http.server import BaseHTTPRequestHandler, HTTPServer
# import socketserver
# import socket
# import ssl

# # 代理服务器的地址和端口
# HOST = '127.0.0.1'
# PORT = 8888

# class ProxyHandler(BaseHTTPRequestHandler):
#     def do_CONNECT(self):
#         self.send_response(200)
#         self.send_header('Connection', 'Keep-Alive')
#         self.end_headers()
#         print('链接',self.path)
#         try:
#             self._connect_to(self.path)
#         except socket.error as err:
#             self.log_error("连接错误: %s", err)
#             return

#     def log_message(self, format, *args):
#         # Override log_message to handle non-ASCII characters
#         print(format)
#         self.log_message(format % args)

#     # Override send_response to handle non-ASCII status messages
#     def send_response(self, code, message=None):
#         if message is None:
#             if code in self.responses:
#                 message = self.responses[code][0]
#             else:
#                 message = ''
#         if isinstance(message, str):
#             message = message.encode('utf-8', 'surrogateescape')
#         self.send_response_only(code, message)

#     def do_GET(self):
#         self._handle_request()

#     def do_POST(self):
#         self._handle_request()

#     def _handle_request(self):
#         url = self.path
#         if url.startswith('/'):
#             url = 'http://' + self.headers['Host'] + url

#         i = url.find('://')
#         protocol = url[:i]
#         url = url[i+3:]
#         i = url.find('/')
#         if i != -1:
#             host = url[:i]
#             path = url[i:]
#         else:
#             host = url
#             path = '/'

#         try:
#             remote = socket.create_connection((host, 80))
#             remote.sendall(self.requestline.encode('iso-8859-1') + b'\r\n')

#             for header, value in self.headers.items():
#                 if header not in ['Host', 'Connection']:
#                     remote.sendall((header + ': ' + value + '\r\n').encode('iso-8859-1'))
#             remote.sendall(b'Host: ' + host.encode('iso-8859-1') + b'\r\n')
#             remote.sendall(b'Connection: close\r\n\r\n')

#             while True:
#                 buf = remote.recv(8192)
#                 if not buf:
#                     break
#                 self.connection.send(buf)
#             remote.close()
#             self.connection.close()
#         except Exception as e:
#             print('error:', e)

#     def log_message(self, format, *args):
#         pass

# # 创建 HTTPS 代理服务器
# with socketserver.TCPServer((HOST, PORT), ProxyHandler) as httpd:
#     # 创建 SSL 上下文
#     context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
#     context.load_cert_chain(certfile='server.crt', keyfile='server.key')
#     httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    
#     print(f"HTTPS proxy server running at https://{HOST}:{PORT}")
#     httpd.serve_forever()

from mitmproxy import http
from mitmproxy.proxy.config import ProxyConfig
from mitmproxy.proxy.server import ProxyServer

def request(flow: http.HTTPFlow) -> None:
    # 修改请求或处理逻辑可以在这里添加
    pass

def response(flow: http.HTTPFlow) -> None:
    # 修改响应或处理逻辑可以在这里添加
    pass

if __name__ == "__main__":
    config = ProxyConfig(port=8888)
    server = ProxyServer(config)
    print(f"Proxy server listening on port {config.port}")
    try:
        from mitmproxy.tools.main import mitmdump
        mitmdump(["-p", str(config.port)])
    except SystemExit as e:
        pass