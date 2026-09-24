#!/usr/bin/perl
# Strict, deliberately limited Docker leaf-tar reader, not a general extractor.
use strict;
use warnings;
my ($archive, $expected, $output, $remaining) = @ARGV;
open my $in, '<:raw', $archive or die "archive: $!\n";
sub take {
    my ($n) = @_;
    my $s = '';
    while (length($s) < $n) {
        my $got = read($in, my $chunk, $n - length($s));
        defined($got) && $got > 0 or die "truncated archive\n";
        $s .= $chunk;
    }
    return $s;
}
sub text { my $s = shift; $s =~ s/\0.*\z//s; return $s; }
sub octal {
    my $s = shift;
    $s =~ /\A[0-7]+[\0 ]*\z/ or die "non-octal tar field\n";
    return oct($s);
}
my $h = take(512);
my $stored = octal(substr($h, 148, 8));
my $check = $h; substr($check, 148, 8) = ' ' x 8;
$stored == unpack('%32C*', $check) or die "bad tar checksum\n";
my $type = substr($h, 156, 1);
warn 'Observed tar leaf type: ' . ($type eq "\0" ? 'NUL' : $type) . "\n";
($type eq '0' || $type eq "\0") or die "not regular (symlink/directory/extensions rejected)\n";
text(substr($h, 0, 100)) eq $expected or die "unexpected leaf name\n";
substr($h, 257, 6) eq "ustar\0" or die "only strict ustar supported\n";
text(substr($h, 345, 155)) eq '' or die "prefixed path rejected\n";
text(substr($h, 157, 100)) eq '' or die "link target rejected\n";
my $size = octal(substr($h, 124, 12));
$size <= 134217728 && $size <= $remaining or die "inspect-only size limit exceeded\n";
open my $out, '>:raw', $output or die "output: $!\n";
chmod 0600, $output or die "chmod: $!\n";
my $left = $size;
while ($left) {
    my $n = $left > 65536 ? 65536 : $left;
    print {$out} take($n) or die "write: $!\n";
    $left -= $n;
}
close $out or die "close: $!\n";
my $pad = (512 - $size % 512) % 512;
take($pad) eq "\0" x $pad or die "nonzero padding\n";
take(1024) eq "\0" x 1024 or die "extra entries or missing terminator\n";
while (1) {
    my $n = read($in, my $chunk, 65536);
    defined($n) or die "read: $!\n";
    last unless $n;
    $chunk =~ /\A\0*\z/ or die "trailing data\n";
}
print "$size\n";
