#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface GraphBytesInstaller : NSObject

/** `runtime`: the `jsi::Runtime *` the module runs on (JS thread). */
+ (void)installInRuntime:(void *)runtime;

@end

NS_ASSUME_NONNULL_END
