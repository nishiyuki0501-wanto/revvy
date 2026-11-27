#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
// Performs one HTTPS GET. On a redirect, returns empty data and the next URL.
NSData * _Nullable RevvyFetchImage(NSURL *url, NSUInteger byteLimit,
                                   BOOL (^allowAddress)(NSString *),
                                   NSURL * _Nullable * _Nonnull redirect);
NS_ASSUME_NONNULL_END
