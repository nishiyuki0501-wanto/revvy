#import "ImageTransfer.h"
#import <curl/curl.h>
#import <netdb.h>

typedef struct {
    __unsafe_unretained NSMutableData *data;
    NSUInteger limit;
    __unsafe_unretained BOOL (^allowAddress)(NSString *);
} ImageTransfer;

static curl_socket_t openPublicSocket(void *context, curlsocktype purpose, struct curl_sockaddr *endpoint) {
    char host[NI_MAXHOST];
    if (purpose != CURLSOCKTYPE_IPCXN ||
        getnameinfo(&endpoint->addr, endpoint->addrlen, host, sizeof(host), NULL, 0, NI_NUMERICHOST) != 0)
        return CURL_SOCKET_BAD;
    ImageTransfer *transfer = context;
    if (!transfer->allowAddress([NSString stringWithUTF8String:host])) return CURL_SOCKET_BAD;
    return socket(endpoint->family, endpoint->socktype, endpoint->protocol);
}

static size_t receiveBytes(char *bytes, size_t size, size_t count, void *context) {
    ImageTransfer *transfer = context;
    if (size && count > (transfer->limit - transfer->data.length) / size) return 0;
    [transfer->data appendBytes:bytes length:size * count];
    return size * count;
}

NSData *RevvyFetchImage(NSURL *url, NSUInteger byteLimit, BOOL (^allowAddress)(NSString *), NSURL **redirect) {
    CURL *curl = curl_easy_init();
    if (!curl) return nil;
    NSMutableData *data __attribute__((objc_precise_lifetime)) = [NSMutableData data];
    ImageTransfer transfer = {data, byteLimit, allowAddress};
    long status = 0;
    NSData *result = nil;
    // Fail closed if the system libcurl cannot apply any transport control.
#define SET(option, value) if (curl_easy_setopt(curl, option, value) != CURLE_OK) goto done
    SET(CURLOPT_URL, url.absoluteString.UTF8String);
    SET(CURLOPT_PROTOCOLS_STR, "https");
    SET(CURLOPT_DISALLOW_USERNAME_IN_URL, 1L);
    SET(CURLOPT_PROXY, "");
    SET(CURLOPT_NOSIGNAL, 1L);
    SET(CURLOPT_TIMEOUT, 15L);
    SET(CURLOPT_MAXFILESIZE_LARGE, (curl_off_t)byteLimit);
    SET(CURLOPT_OPENSOCKETFUNCTION, openPublicSocket);
    SET(CURLOPT_OPENSOCKETDATA, &transfer);
    SET(CURLOPT_WRITEFUNCTION, receiveBytes);
    SET(CURLOPT_WRITEDATA, &transfer);
#undef SET
    if (curl_easy_perform(curl) != CURLE_OK || curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status) != CURLE_OK) goto done;
    if (status >= 200 && status < 300) result = data;
    else if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
        char *next = NULL;
        if (curl_easy_getinfo(curl, CURLINFO_REDIRECT_URL, &next) == CURLE_OK && next) {
            *redirect = [NSURL URLWithString:[NSString stringWithUTF8String:next]];
            if (*redirect) result = [NSData data];
        }
    }
done:
    curl_easy_cleanup(curl);
    return result;
}
